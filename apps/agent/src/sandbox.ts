import { existsSync } from "node:fs";
import path from "node:path";
import { SANDBOX } from "./constants.ts";

// Each owner's opencode runs confined (src/pool.ts). The agent runs inside a Nitro Enclave, which
// has no KVM, so microVMs (Firecracker) can't run there; Linux namespaces can.
//
// - "bwrap" (Linux, gateway as root): bubblewrap gives the instance its own pid, mount, ipc and uts
//   namespaces, a filesystem holding only the system's read-only paths, the parts of the app it
//   needs and its owner's home, then setpriv drops it to the owner's own uid with no capabilities
//   and no_new_privs. Its /proc lists only its own processes.
// - "bwrap-user" (Linux, not root): the same namespaces inside an unprivileged user namespace; every
//   owner keeps the gateway's uid, but no instance can see another's files or processes.
// - "uid" (Linux as root, no bubblewrap): separate uids only (setpriv). Homes are 0700, so files
//   and process environments stay private, but process lists are shared.
// - "none" (macOS, or AGENT_SANDBOX=off): separate processes and directories, nothing more.
//
// Network: instances share the gateway's network namespace, so they reach exactly what the
// enclave already allows (loopback, and the vsock-proxied model, GitHub, OSV and KMS hosts). Each
// instance's server and model relay listen on loopback behind their own random secrets.

export type Mode = "bwrap" | "bwrap-user" | "uid" | "none";

const which = (bin: string) => Bun.which(bin) ?? undefined;

export function detect(): { mode: Mode; why?: string } {
  if (SANDBOX.mode === "off") return { mode: "none", why: "AGENT_SANDBOX=off" };
  if (process.platform !== "linux") return { mode: "none", why: `${process.platform} has no namespaces` };
  const root = process.getuid?.() === 0;
  const bwrap = which("bwrap");
  const setpriv = which("setpriv");
  // bubblewrap may be installed but unusable (no user namespaces for unprivileged users, a
  // container without the right capabilities): try it once.
  const works = (args: string[]) => bwrap !== undefined && Bun.spawnSync([bwrap, ...args, "--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stderr: "ignore" }).exitCode === 0;
  if (bwrap && root && setpriv && works([])) return { mode: "bwrap" };
  if (bwrap && !root && works(["--unshare-user"])) return { mode: "bwrap-user" };
  if (root && setpriv) return { mode: "uid", why: "bubblewrap isn't installed: separate uids only" };
  return { mode: "none", why: root ? "neither bubblewrap nor setpriv is usable" : "bubblewrap isn't usable here and the gateway isn't root" };
}

export interface Confine {
  mode: Mode;
  /** The owner's home: the only writable path, and the only owner directory there is. */
  home: string;
  /** The owner's uid and gid ("bwrap" and "uid" modes). */
  uid?: number;
  /** Where the instance starts. */
  cwd: string;
  /** apps/agent, whose SANDBOX.app parts are bound read-only. */
  app: string;
  /** More read-only paths (the tests' MCP stub needs Bun's). */
  readOnly?: string[];
  /** Paths shared writable between instances: tests only (the stub MCP servers' call log). */
  shared?: string[];
}

/** The command line that runs `cmd` confined. */
export function wrap(cmd: string[], c: Confine): string[] {
  const drop = (uid: number) => [which("setpriv") ?? "setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", "--"];
  if (c.mode === "none") return cmd;
  if (c.mode === "uid") return [...drop(c.uid!), ...cmd];
  const ro = [...SANDBOX.readOnly, ...SANDBOX.app.map((p) => path.join(c.app, p)), ...(c.readOnly ?? [])].filter((p) => existsSync(p));
  const targets = [...ro, ...(c.shared ?? []), c.home];
  const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
  // bubblewrap makes missing parents of a mount 0700 root, which the owner's uid couldn't pass
  // through: make them first, traversable. (Not inside a bound path: those come from the host.)
  const parents = [...new Set(targets.flatMap((t) => {
    const out: string[] = [];
    for (let d = path.dirname(t); d !== path.dirname(d); d = path.dirname(d)) out.unshift(d);
    return out;
  }))]
    .filter((d) => !targets.some((t) => inside(d, t)) && !["/tmp", "/run", "/proc", "/dev"].includes(d))
    .sort((x, y) => x.length - y.length);
  return [
    which("bwrap")!,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    // As root, bubblewrap keeps its capabilities for setpriv, which drops them all with the uid.
    ...(c.mode === "bwrap-user" ? ["--unshare-user"] : []),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    ...parents.flatMap((d) => ["--perms", "0711", "--dir", d]),
    ...ro.flatMap((p) => ["--ro-bind", p, p]),
    ...(c.shared ?? []).flatMap((p) => ["--bind", p, p]),
    "--bind", c.home, c.home,
    "--chdir", c.cwd,
    "--",
    ...(c.mode === "bwrap" ? drop(c.uid!) : []),
    ...cmd,
  ];
}
