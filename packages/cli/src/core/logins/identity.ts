import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";
import path from "node:path";
import { LOGINS } from "../../constants.ts";

// Who an agent is, for login grants. The name a client reports in `initialize` (or `--agent`) is
// only a label: any local process can claim to be "claude-code". Grants are bound to `id`, which
// the client can't choose: over stdio, the program that started `sikrets mcp` (its code-signing
// team and identifier on macOS, else its path and a hash of its contents); over HTTP, the client
// whose token was presented.
//
// What this does not stop: another script run by the same program. Agents that run on a shared
// interpreter (node, python) share its identity, so the dialog shows the program to make that visible.

export interface AgentIdentity {
  /** What the person sees in approvals and the activity log. */
  readonly name: string;
  /** What grants are bound to. */
  readonly id: string;
  /** Shown in the approval dialog, e.g. the program's path. */
  readonly detail?: string;
}

const run = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return out + err;
};

async function executable(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return readlink(`/proc/${pid}/exe`).catch(() => undefined);
  // lsof's first "txt" entry is the program image itself, not argv[0] (which a process can set).
  const out = await run(["lsof", "-a", "-p", String(pid), "-d", "txt", "-Fn"]).catch(() => "");
  return out.split("\n").find((l) => l.startsWith("n/"))?.slice(1);
}

const parentOf = async (pid: number) => Number((await run(["ps", "-o", "ppid=", "-p", String(pid)]).catch(() => "")).trim()) || undefined;

async function signer(exe: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const out = await run(["codesign", "-dv", "--verbose=2", exe]).catch(() => "");
  const team = out.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = out.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  // Unsigned and ad-hoc signed programs have no team: anyone can produce those, so they're identified by content.
  if (!team || team === "not set" || !identifier) return undefined;
  return `codesign:${team}:${identifier}`;
}

/**
 * The program that started this server, skipping launchers (shells, npx, bunx) in between.
 * Undefined when it can't be found; callers must then refuse standing grants.
 */
export async function parentIdentity(name: string, pid = process.ppid): Promise<AgentIdentity | undefined> {
  let current: number | undefined = pid;
  for (let hop = 0; current && current > 1 && hop < LOGINS.maxLauncherHops; hop++) {
    const exe = await executable(current);
    if (!exe) return undefined;
    if ((LOGINS.launchers as readonly string[]).includes(path.basename(exe))) {
      current = await parentOf(current);
      continue;
    }
    const signed = await signer(exe);
    if (signed) return { name, id: signed, detail: exe };
    const file = Bun.file(exe);
    if (!(await file.exists())) return undefined;
    const hash = createHash("sha256");
    for await (const chunk of file.stream()) hash.update(chunk);
    return { name, id: `sha256:${hash.digest("hex")}`, detail: exe };
  }
  return undefined;
}
