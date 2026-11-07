import { chmod, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCK } from "../constants.ts";

// Bun-native file helpers. Bun.file reads lazily. Every write goes to a temp file and is renamed
// into place, so a crash leaves either the old file or the new one, never half of one.
// Bun has no permission API, so private files fall back to node:fs chmod/mkdir for 0600/0700.

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const f = Bun.file(file);
  return (await f.exists()) ? ((await f.json()) as T) : fallback;
}

export const readText = async (file: string) => {
  const f = Bun.file(file);
  return (await f.exists()) ? f.text() : undefined;
};

/** Replaces `file` atomically: write a sibling temp file, then rename it over the original. */
export async function writeAtomic(file: string, text: string, mode?: number) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, text, mode === undefined ? undefined : { mode });
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export const writeJson = (file: string, value: unknown) => writeAtomic(file, JSON.stringify(value, null, 2) + "\n");

/** Writes a file only you can read, inside a folder only you can open. */
export async function writePrivate(file: string, text: string) {
  await privateDir(path.dirname(file));
  await writeAtomic(file, text, 0o600);
  await chmod(file, 0o600);
}

export async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export const remove = async (file: string) => {
  const f = Bun.file(file);
  if (await f.exists()) await f.delete();
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A lock is stale when its owner on this machine is gone, or it is older than LOCK.staleMs. */
async function stale(lock: string, seen: string): Promise<boolean> {
  const owner = /^(\d+)\b/.exec(seen)?.[1];
  if (owner && !alive(Number(owner))) return true;
  const info = await stat(lock).catch(() => undefined);
  return info !== undefined && Date.now() - info.mtimeMs > LOCK.staleMs;
}

/**
 * Runs `fn` while holding `<file>.lock`, created with O_EXCL so only one sikrets process at a time
 * can read-modify-write `file`. A lock left by a crashed process is taken over.
 */
export async function withLock<T>(file: string, fn: () => Promise<T>, waitMs: number = LOCK.waitMs): Promise<T> {
  const lock = `${file}${LOCK.suffix}`;
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const seen = await readFile(lock, "utf8").catch(() => "");
    if (await stale(lock, seen)) {
      // Claim the stale lock by renaming it, so two processes can't both delete and recreate it.
      const claimed = `${lock}.${crypto.randomUUID().slice(0, 8)}`;
      if (await rename(lock, claimed).then(() => true, () => false)) {
        // Someone replaced it between our read and the rename: put theirs back.
        if ((await readFile(claimed, "utf8").catch(() => "")) !== seen) await link(claimed, lock).catch(() => {});
        await unlink(claimed).catch(() => {});
      }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Another sikrets process is using ${path.basename(file)}. Try again; if none is running, delete ${lock}`);
    await Bun.sleep(LOCK.retryMs);
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}
