import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FILE_LOCK } from "../constants.ts";

// Bun-native file helpers. Bun.write creates missing parent folders and Bun.file reads lazily.
// Bun has no permission API, so private files fall back to node:fs chmod/mkdir for 0600/0700.

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const f = Bun.file(file);
  return (await f.exists()) ? ((await f.json()) as T) : fallback;
}

export const readText = async (file: string) => {
  const f = Bun.file(file);
  return (await f.exists()) ? f.text() : undefined;
};

export const writeJson = (file: string, value: unknown) => Bun.write(file, JSON.stringify(value, null, 2) + "\n");

/** Writes a file only you can read, inside a folder only you can open. */
export async function writePrivate(file: string, text: string) {
  await privateDir(file.slice(0, file.lastIndexOf("/")));
  await Bun.write(file, text);
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

/** Writes a private file all at once: a temp file beside it, then a rename, so readers never see half of it. */
export async function writePrivateAtomic(file: string, text: string) {
  await privateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

const holderAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A lock left by a process that died, or held longer than any update takes. */
async function isStale(lock: string): Promise<boolean> {
  try {
    const [info, text] = await Promise.all([stat(lock), readFile(lock, "utf8")]);
    const pid = Number(text.split(" ")[0]);
    return Date.now() - info.mtimeMs > FILE_LOCK.staleMs || (Number.isInteger(pid) && pid > 0 && !holderAlive(pid));
  } catch {
    return false; // gone already: just try again
  }
}

/**
 * Runs `fn` while holding `<file>.lock`, created with O_EXCL so only one process (and one caller in
 * this one) holds it. A lock from a dead process, or an old one, is taken over.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = file + FILE_LOCK.suffix;
  await privateDir(path.dirname(file));
  const deadline = Date.now() + FILE_LOCK.waitMs;
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStale(lock)) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${file} is locked by another sikrets process. If none is running, delete ${lock}`);
      await Bun.sleep(FILE_LOCK.retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

/**
 * Read-modify-write of a private JSON file under its lock, written atomically, so no writer loses
 * another's change. `fn` returns the new value, or undefined to leave the file as it is.
 */
export function updateJson<T>(file: string, fallback: T, fn: (current: T) => T | undefined | Promise<T | undefined>): Promise<T> {
  return withFileLock(file, async () => {
    const current = await readJson(file, fallback);
    const next = await fn(current);
    if (next === undefined) return current;
    await writePrivateAtomic(file, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}
