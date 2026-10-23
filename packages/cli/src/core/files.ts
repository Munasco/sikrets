import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerUndo } from "./plan.ts";

// Generated IaC belongs to the project, like shadcn components. sikrets.lock records the hash we
// wrote, so we can tell when someone has edited a file and never overwrite or delete their changes.

const lockFile = (root: string) => path.join(root, "sikrets.lock");
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function readLock(root: string): Promise<{ version: 1; files: Record<string, string> }> {
  try {
    return JSON.parse(await readFile(lockFile(root), "utf8"));
  } catch {
    return { version: 1, files: {} };
  }
}

export async function writeGenerated(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  const lock = await readLock(root);
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing !== undefined && lock.files[rel] !== hash(existing)) {
    throw new Error(`${rel} was edited since Sikrets generated it; move your changes or delete the file first`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  lock.files[rel] = hash(text);
  await writeFile(lockFile(root), JSON.stringify(lock, null, 2) + "\n");
}

registerUndo("file.delete", async ({ path: rel }, ctx) => {
  const file = path.join(ctx.root, rel!);
  const lock = await readLock(ctx.root);
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current !== undefined && lock.files[rel!] !== hash(current)) {
    ctx.log(`    kept ${rel}: it was edited after generation`);
    return;
  }
  await rm(file, { force: true });
  delete lock.files[rel!];
  await writeFile(lockFile(ctx.root), JSON.stringify(lock, null, 2) + "\n");
});
