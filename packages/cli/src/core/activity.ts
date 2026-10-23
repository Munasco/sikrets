import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureGitignore } from "./files.ts";
import { readText } from "./fs.ts";

// Project activity log: what happened, who did it, which key *names* were involved. Never values.
// One JSON object per line in .sikrets/activity.jsonl (git-ignored: it holds usernames and command
// names). Bun.write has no append mode, so this uses node:fs appendFile.

export type ActivityKind = "add" | "rollback" | "apply" | "env.pull" | "run";

export interface Activity {
  at: string;
  kind: ActivityKind;
  user: string;
  /** Short human summary, e.g. "upstash/redis cache" or "bun (exit 0, 1.2s)". */
  detail: string;
  /** Env var names involved (never values). */
  keys?: string[];
  /** env.pull only: whether real values were written instead of stand-ins. */
  real?: boolean;
  exitCode?: number;
  ms?: number;
}

const FILE = path.join(".sikrets", "activity.jsonl");
const LOG_IGNORE = ".sikrets/activity.jsonl";

export async function record(root: string, entry: Omit<Activity, "at" | "user">): Promise<void> {
  const full: Activity = { at: new Date().toISOString(), user: os.userInfo().username, ...entry };
  await mkdir(path.join(root, ".sikrets"), { recursive: true });
  await ensureGitignore(root, [LOG_IGNORE]);
  await appendFile(path.join(root, FILE), JSON.stringify(full) + "\n");
}

export async function readActivity(root: string): Promise<Activity[]> {
  const text = (await readText(path.join(root, FILE))) ?? "";
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Activity];
      } catch {
        return []; // a torn last line from a crash is skipped, not fatal
      }
    });
}

/** When each key name was last handed to a process. */
export function lastUsed(entries: readonly Activity[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) if (e.kind === "run") for (const k of e.keys ?? []) out.set(k, e.at);
  return out;
}
