import path from "node:path";
import { readJson, readText, remove, writeJson } from "./fs.ts";
import { registerUndo } from "./plan.ts";

// Generated IaC belongs to the project, like shadcn components. sikrets.lock records the hash we
// wrote, so we can tell when someone has edited a file and never overwrite or delete their changes.

const lockFile = (root: string) => path.join(root, "sikrets.lock");
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const readLock = (root: string) => readJson<{ version: 1; files: Record<string, string> }>(lockFile(root), { version: 1, files: {} });

export async function writeGenerated(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  const lock = await readLock(root);
  const existing = await readText(file);
  if (existing !== undefined && lock.files[rel] !== hash(existing)) {
    throw new Error(`${rel} was edited since Sikrets generated it; move your changes or delete the file first`);
  }
  await Bun.write(file, text);
  lock.files[rel] = hash(text);
  await writeJson(lockFile(root), lock);
}

registerUndo("file.delete", async ({ path: rel }, ctx) => {
  const file = path.join(ctx.root, rel!);
  const lock = await readLock(ctx.root);
  const current = await readText(file);
  if (current !== undefined && lock.files[rel!] !== hash(current)) {
    ctx.log(`    kept ${rel}: it was edited after generation`);
    return;
  }
  await remove(file);
  delete lock.files[rel!];
  await writeJson(lockFile(ctx.root), lock);
});
