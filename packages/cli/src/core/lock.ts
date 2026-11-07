import { chmod, link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { LOCK } from "../constants.ts";

// Cross-process guards for small JSON state files. A lock is a sibling `<file>.lock` created with
// O_EXCL that holds the owner's pid; one left by a dead process, or older than LOCK.staleMs, is
// broken. Writes go to a temp file and are renamed into place, so readers never see half a file.

/** Whether a process with this pid exists (on this machine). */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function stale(lock: string): Promise<boolean> {
  try {
    const [info, text] = [await stat(lock), await Bun.file(lock).text()];
    const pid = Number(text.trim());
    return Date.now() - info.mtimeMs > LOCK.staleMs || (Number.isInteger(pid) && pid > 0 && !alive(pid));
  } catch {
    return false; // gone already, or mid-write by its owner: just retry
  }
}

/** Runs `fn` while holding `<file>.lock`. Waits up to LOCK.waitMs for another holder. */
export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK.waitMs;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await stale(lock)) await rm(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`${path.basename(file)} is locked by another sikrets process. Try again, or remove ${lock} if none is running`);
      else await Bun.sleep(LOCK.retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

const tempFor = (file: string) => `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

/** Replaces `file` in one step: write a temp file beside it, then rename over. */
export async function writeAtomic(file: string, text: string, mode?: number) {
  const tmp = tempFor(file);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(tmp, text);
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, file);
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
