import path from "node:path";
import { readJson, readText, remove, withLock, writeAtomic, writeJson } from "./fs.ts";
import { registerUndo, type Context } from "./plan.ts";
import { FILES } from "../constants.ts";

// Generated IaC belongs to the project, like shadcn components. sikrets.lock records the hash of
// what Sikrets last wrote, so it can tell when someone has edited a file and never overwrites or
// deletes their changes. A rewrite records the new hash (keeping the old one as `previous`) before
// touching the file, then drops `previous`, so a crash in between never makes Sikrets' own file
// look hand-edited.

interface Lock {
  version: 1;
  files: Record<string, string>;
  /** Hash a file had before an unfinished rewrite. */
  previous?: Record<string, string>;
}

const lockFile = (root: string) => path.join(root, FILES.lock);
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const readLock = (root: string) => readJson<Lock>(lockFile(root), { version: 1, files: {} });
const ours = (lock: Lock, rel: string, text: string) => [lock.files[rel], lock.previous?.[rel]].includes(hash(text));

/** True if the file exists and is still exactly what Sikrets generated. */
export async function isGenerated(root: string, rel: string): Promise<boolean> {
  const current = await readText(path.join(root, rel));
  return current !== undefined && ours(await readLock(root), rel, current);
}

export async function writeGenerated(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  await withLock(lockFile(root), async () => {
    const lock = await readLock(root);
    const current = await readText(file);
    if (current !== undefined && !ours(lock, rel, current)) {
      throw new Error(`${rel} was edited since Sikrets generated it; move your changes or delete the file first`);
    }
    const previous = current === undefined ? lock.previous : { ...lock.previous, [rel]: hash(current) };
    await writeJson(lockFile(root), { ...lock, files: { ...lock.files, [rel]: hash(text) }, ...(previous ? { previous } : {}) });
    await writeAtomic(file, text);
    await writeJson(lockFile(root), settle({ ...lock, files: { ...lock.files, [rel]: hash(text) } }, rel));
  });
}

/** Deletes a generated file unless someone edited it, in which case it is kept and reported. */
export async function removeGenerated(root: string, rel: string, ctx: Pick<Context, "log">) {
  const file = path.join(root, rel);
  await withLock(lockFile(root), async () => {
    const lock = await readLock(root);
    const current = await readText(file);
    if (current !== undefined && !ours(lock, rel, current)) {
      ctx.log(`    kept ${rel}: it was edited after generation`);
      return;
    }
    await remove(file);
    const { [rel]: _, ...files } = lock.files;
    await writeJson(lockFile(root), settle({ ...lock, files }, rel));
  });
}

/** Drops the `previous` entry for a file once its rewrite or removal has finished. */
function settle(lock: Lock, rel: string): Lock {
  const { [rel]: _, ...previous } = lock.previous ?? {};
  const { previous: __, ...rest } = lock;
  return Object.keys(previous).length ? { ...rest, previous } : rest;
}

/** Appends missing lines to .gitignore; never removes anything. */
export async function ensureGitignore(root: string, rules: readonly string[]) {
  const file = path.join(root, ".gitignore");
  const current = (await readText(file)) ?? "";
  const lines = new Set(current.split(/\r?\n/));
  const missing = rules.filter((r) => !lines.has(r));
  if (missing.length) await writeAtomic(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}# Sikrets: Terraform state and env files hold secret values\n${missing.join("\n")}\n`);
}

registerUndo("file.delete", ({ path: rel }, ctx) => removeGenerated(ctx.root, rel!, ctx));
