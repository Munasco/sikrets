import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { privateDir, readText } from "./fs.ts";
import { configDir } from "../store.ts";
import { USAGE_DIR } from "../constants.ts";

// Usage log: every time the CLI hands a key to something, which key *name* went to which app or
// agent, and when. Never values. It lives in the user dir (~/.sikrets/usage/<project>.jsonl,
// owner-only), outside the project, so it can't be committed or synced with it, and nothing in
// Sikrets ever sends it anywhere. `inventory` and `offboard` read it.

export type UseVia = "run" | "env.pull" | "aws.session" | "github.token";

export interface Use {
  at: string;
  /** Key name, e.g. CACHE_REDIS_REST_TOKEN (never its value). */
  key: string;
  via: UseVia;
  /** What received it: a program name, an env file, or "env export". */
  app: string;
  /** OS user who ran the command. */
  user: string;
  /** Agent identity the key was handed to, if any (see core/agents.ts). */
  agent?: string;
}

const file = (project: string) => path.join(configDir(), USAGE_DIR, `${project}.jsonl`);

export async function recordUse(project: string, use: { keys: readonly string[]; via: UseVia; app: string; agent?: string }): Promise<void> {
  if (!use.keys.length) return;
  const at = new Date().toISOString();
  const user = os.userInfo().username;
  const lines = use.keys.map((key) => JSON.stringify({ at, key, via: use.via, app: use.app, user, ...(use.agent ? { agent: use.agent } : {}) } satisfies Use));
  await privateDir(path.join(configDir(), USAGE_DIR));
  await appendFile(file(project), lines.join("\n") + "\n", { mode: 0o600 });
}

export async function readUsage(project: string): Promise<Use[]> {
  const text = (await readText(file(project))) ?? "";
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Use];
      } catch {
        return []; // a torn last line from a crash is skipped, not fatal
      }
    });
}

export interface KeyUsage {
  lastUsed: string;
  apps: Set<string>;
  agents: Set<string>;
  users: Set<string>;
}

/** Per key: when it was last handed out, and to which apps, agents and people. */
export function usageByKey(uses: readonly Use[]): Map<string, KeyUsage> {
  const out = new Map<string, KeyUsage>();
  for (const u of uses) {
    const k = out.get(u.key) ?? { lastUsed: u.at, apps: new Set(), agents: new Set(), users: new Set() };
    if (u.at > k.lastUsed) k.lastUsed = u.at;
    k.apps.add(u.app);
    k.users.add(u.user);
    if (u.agent) k.agents.add(u.agent);
    out.set(u.key, k);
  }
  return out;
}

/** Keys a person (OS user, outside any agent) or an agent was handed. */
export const touchedBy = (uses: readonly Use[], who: string): string[] =>
  [...new Set(uses.filter((u) => u.agent === who || (!u.agent && u.user === who)).map((u) => u.key))];
