import { chmod, link, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { LOCK } from "../constants.ts";

// Cross-process guards for small JSON state files (approvals, agents, keys, recovery), which the CLI
// and the desktop app may write at the same time. A lock is a sibling `<file>.lock` created with
// O_EXCL that names its holder: pid, the process's start time and a token. The lock stays live while
// that process is alive, however long it takes (a long import), up to LOCK.maxHoldMs. It's broken
// when the holder is dead or the pid now belongs to another process (a different start time).
// Writes go to a temp file renamed into place, so readers never see half a file.

interface Holder {
  pid: number;
  /** Process start time as `ps` reports it; tells a reused pid from the holder. */
  start?: string;
  at: number;
  token: string;
}

/** Whether a process with this pid exists (on this machine). */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

/** When `pid` started, or undefined if it isn't running (or `ps` can't say). */
export function processStart(pid: number): string | undefined {
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const text = out.stdout.toString().trim();
    return out.exitCode === 0 && text ? text : undefined;
  } catch {
    return undefined;
  }
}

let ownStart: string | undefined;
const myStart = () => (ownStart ??= processStart(process.pid));

/** Whether the process that wrote `{pid, start}` is still that process. Without a start, pid liveness only. */
export function holderAlive(pid: number, start?: string): boolean {
  if (pid === process.pid) return start === undefined || start === myStart();
  if (!alive(pid)) return false;
  if (start === undefined) return true;
  const now = processStart(pid);
  return now === undefined || now === start; // can't tell: assume it's still the holder
}

/** The identity to record for this process, so others can tell when it has gone. */
export const self = () => ({ pid: process.pid, start: myStart() });

type Seen = { raw: string; holder?: Holder; mtime: number };

async function read(lock: string): Promise<Seen | undefined> {
  try {
    const [raw, s] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
    return { raw, holder: parse(raw), mtime: s.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parse(raw: string): Holder | undefined {
  try {
    const h = JSON.parse(raw) as Holder | number;
    if (typeof h === "number") return Number.isInteger(h) && h > 0 ? { pid: h, at: 0, token: "" } : undefined; // older locks held just a pid
    return Number.isInteger(h?.pid) && h.pid > 0 ? h : undefined;
  } catch {
    return undefined; // torn write by a crashed holder
  }
}

/** Live while the holder runs (up to LOCK.maxHoldMs); a lock we can't read is given LOCK.unreadableMs to finish being written. */
export function isStale(seen: Seen, now = Date.now()): boolean {
  const age = now - seen.mtime;
  if (!seen.holder) return age > LOCK.unreadableMs;
  if (age > LOCK.maxHoldMs) return true;
  return !holderAlive(seen.holder.pid, seen.holder.start);
}

/** Removes `lock` only if it still is the stale one we looked at, so a fresh lock isn't stolen. */
async function breakStale(lock: string, seen: string) {
  const aside = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lock, aside);
  } catch {
    return; // someone else broke it first
  }
  const raw = await readFile(aside, "utf8").catch(() => "");
  // Another process replaced it between our read and the rename: put theirs back if we can.
  if (raw !== seen) await link(aside, lock).catch(() => {});
  await unlink(aside).catch(() => {});
}

async function acquire(lock: string): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + LOCK.waitMs;
  for (;;) {
    try {
      const fd = await open(lock, "wx", 0o600);
      await fd.writeFile(JSON.stringify({ ...self(), at: Date.now(), token } satisfies Holder));
      await fd.close();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const seen = await read(lock);
    if (!seen) continue;
    if (isStale(seen)) {
      await breakStale(lock, seen.raw);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`${path.basename(lock, LOCK.suffix)} is locked by sikrets process ${seen.holder?.pid ?? "?"}. Try again when it finishes, or remove ${lock} if none is running`);
    await Bun.sleep(LOCK.retryMs);
  }
}

async function release(lock: string, token: string) {
  const seen = await read(lock).catch(() => undefined);
  if (seen?.holder?.token === token) await unlink(lock).catch(() => {});
}

/** Runs `fn` while holding `<file>.lock`. Waits up to LOCK.waitMs for another holder. Locks don't nest on one file. */
export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = file + LOCK.suffix;
  await mkdir(path.dirname(lock), { recursive: true });
  const token = await acquire(lock);
  try {
    return await fn();
  } finally {
    await release(lock, token);
  }
}

const tempFor = (file: string) => `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

/** Replaces `file` in one step: write a temp file beside it, then rename over. */
export async function writeAtomic(file: string, text: string, mode?: number) {
  const tmp = tempFor(file);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await Bun.write(tmp, text);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Creates `file` with `text` only if it doesn't exist yet. Returns false when something was already there. */
export async function createExclusive(file: string, text: string, mode?: number): Promise<boolean> {
  const tmp = tempFor(file);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(tmp, text);
  if (mode !== undefined) await chmod(tmp, mode);
  try {
    await link(tmp, file); // link fails with EEXIST instead of replacing, unlike rename
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}
