import path from "node:path";
import { readJson, readText, remove, writeJson } from "./fs.ts";
import { registerUndo, type Context } from "./plan.ts";
import { FILES } from "../constants.ts";

// Generated IaC belongs to the project, like shadcn components. sikrets.lock records the hash of
// what Sikrets last wrote, so it can tell when someone has edited a file and never overwrites or
// deletes their changes.

interface Lock {
  version: 1;
  files: Record<string, string>;
}

const lockFile = (root: string) => path.join(root, FILES.lock);
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const readLock = (root: string) => readJson<Lock>(lockFile(root), { version: 1, files: {} });

/** True if the file exists and is still exactly what Sikrets generated. */
export async function isGenerated(root: string, rel: string): Promise<boolean> {
  const current = await readText(path.join(root, rel));
  return current !== undefined && (await readLock(root)).files[rel] === hash(current);
}

export async function writeGenerated(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  const lock = await readLock(root);
  const current = await readText(file);
  if (current !== undefined && lock.files[rel] !== hash(current)) {
    throw new Error(`${rel} was edited since Sikrets generated it; move your changes or delete the file first`);
  }
  await Bun.write(file, text);
  lock.files[rel] = hash(text);
  await writeJson(lockFile(root), lock);
}

/** Deletes a generated file unless someone edited it, in which case it is kept and reported. */
export async function removeGenerated(root: string, rel: string, ctx: Pick<Context, "log">) {
  const file = path.join(root, rel);
  const lock = await readLock(root);
  const current = await readText(file);
  if (current !== undefined && lock.files[rel] !== hash(current)) {
    ctx.log(`    kept ${rel}: it was edited after generation`);
    return;
  }
  await remove(file);
  delete lock.files[rel];
  await writeJson(lockFile(root), lock);
}

/** Appends missing lines to .gitignore; never removes anything. */
export async function ensureGitignore(root: string, rules: readonly string[]) {
  const file = path.join(root, ".gitignore");
  const current = (await readText(file)) ?? "";
  const lines = new Set(current.split(/\r?\n/));
  const missing = rules.filter((r) => !lines.has(r));
  if (missing.length) await Bun.write(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}# Sikrets: Terraform state and env files hold secret values\n${missing.join("\n")}\n`);
}

registerUndo("file.delete", ({ path: rel }, ctx) => removeGenerated(ctx.root, rel!, ctx));
