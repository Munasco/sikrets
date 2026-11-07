import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { FILE_LOCK } from "../constants.ts";

// A cross-process lock for read-modify-write on a shared file (agents.json, written by the CLI and
// by the desktop app at the same time). The lock is <file>.lock, created with O_EXCL so only one
// process holds it. A lock whose process is gone, or that is older than FILE_LOCK.staleMs, was left
// by a crash and is taken over.

interface Holder {
  pid: number;
  at: number;
  token: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

async function holder(lock: string): Promise<{ raw: string; h?: Holder; mtime: number } | undefined> {
  try {
    const [raw, s] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
    try {
      return { raw, h: JSON.parse(raw) as Holder, mtime: s.mtimeMs };
    } catch {
      return { raw, mtime: s.mtimeMs }; // torn write by a crashed holder
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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

async function acquire(lock: string): Promise<string> {
  const token = crypto.randomUUID();
  const deadline = Date.now() + FILE_LOCK.timeoutMs;
  for (;;) {
    try {
      const fd = await open(lock, "wx", 0o600);
      await fd.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token } satisfies Holder));
      await fd.close();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await holder(lock);
    if (!current) continue;
    const stale = Date.now() - current.mtime > FILE_LOCK.staleMs || (current.h !== undefined && current.h.pid !== process.pid && !alive(current.h.pid));
    if (stale) {
      await breakStale(lock, current.raw);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`${lock} is held by process ${current.h?.pid ?? "?"}. If no sikrets process is running, delete it`);
    await Bun.sleep(FILE_LOCK.retryMs);
  }
}

async function release(lock: string, token: string) {
  const current = await holder(lock);
  if (current?.h?.token === token) await unlink(lock).catch(() => {});
}

/** Runs `fn` while holding the lock for `file`. Calls nest per process only if they lock different files. */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = file + FILE_LOCK.suffix;
  await mkdir(path.dirname(lock), { recursive: true });
  const token = await acquire(lock);
  try {
    return await fn();
  } finally {
    await release(lock, token);
  }
}
