import { chmod, link, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LOCK } from "../constants.ts";

// Cross-process guards for small shared state files (approvals.json, agents.json, the data key),
// written by the CLI and the desktop app at the same time. A lock is a sibling `<file>.lock`
// created with O_EXCL. It records its holder's pid and that process's start time, and stays live
// for as long as that exact process runs, so a long import is never broken into. It is stale only
// when the holder is gone (or the pid now belongs to another process), or past LOCK.ceilingMs.
// Writes go to a temp file renamed into place, so readers never see half a file.

/** Who holds a lock (or runs a rotation): a pid plus when that process started, to survive pid reuse. */
export interface Holder {
  pid: number;
  /** Process start time as the OS reports it; absent when it couldn't be read. */
  start?: string;
}

interface LockRecord extends Holder {
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

/** When `pid` started, per `ps`; undefined if it isn't running or the platform has no `ps`. */
export function startTime(pid: number): string | undefined {
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const text = out.stdout.toString().trim();
    return out.exitCode === 0 && text ? text : undefined;
  } catch {
    return undefined;
  }
}

let ownStart: string | undefined | null = null;
/** This process as a holder. */
export function self(): Holder {
  if (ownStart === null) ownStart = startTime(process.pid);
  return ownStart ? { pid: process.pid, start: ownStart } : { pid: process.pid };
}

/** Whether the process that took a lock (or started a rotation) is still the one running under that pid. */
export function running(h: Holder): boolean {
  if (h.pid === process.pid) return h.start === undefined || h.start === self().start;
  if (!alive(h.pid)) return false;
  if (h.start === undefined) return true; // older record: the pid is all we have
  const now = startTime(h.pid);
  return now === undefined || now === h.start; // unreadable start time: trust the pid
}

/** The lock file as written; accepts the older bare-pid format. Undefined when gone or torn. */
async function readLock(lock: string): Promise<{ raw: string; rec?: Partial<LockRecord>; mtime: number } | undefined> {
  try {
    const [raw, s] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return { raw, rec: { pid: Number(trimmed) }, mtime: s.mtimeMs };
    try {
      return { raw, rec: JSON.parse(raw) as LockRecord, mtime: s.mtimeMs };
    } catch {
      return { raw, mtime: s.mtimeMs }; // torn: a holder crashed mid-write, or is writing right now
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isStale(current: { rec?: Partial<LockRecord>; mtime: number }, now = Date.now()): boolean {
  const age = now - current.mtime;
  if (age > LOCK.ceilingMs) return true;
  const pid = current.rec?.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return age > LOCK.tornMs;
  return !running({ pid: pid as number, start: current.rec?.start });
}

/** Removes `lock` only if it still is the stale one we looked at, so a fresh lock isn't stolen. */
async function breakStale(lock: string, seen: string) {
  const aside = `${lock}.${process.pid}.${crypto.randomUUID()}.stale`;
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

async function acquire(file: string, lock: string): Promise<string> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK.waitMs;
  for (;;) {
    try {
      const fd = await open(lock, "wx", 0o600);
      await fd.writeFile(JSON.stringify({ ...self(), at: Date.now(), token } satisfies LockRecord));
      await fd.close();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await readLock(lock);
    if (!current) continue;
    if (isStale(current)) {
      await breakStale(lock, current.raw);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`${path.basename(file)} is locked by sikrets process ${current.rec?.pid ?? "?"}. Try again, or remove ${lock} if none is running`);
    }
    await Bun.sleep(LOCK.retryMs);
  }
}

async function release(lock: string, token: string) {
  const current = await readLock(lock);
  if (current?.rec?.token === token) await unlink(lock).catch(() => {});
}

/** Runs `fn` while holding `<file>.lock`. Waits up to LOCK.waitMs for another holder. Calls nest only for different files. */
export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = file + LOCK.suffix;
  await mkdir(path.dirname(lock), { recursive: true });
  const token = await acquire(file, lock);
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
