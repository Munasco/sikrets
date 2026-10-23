import { ensureGitignore } from "./files.ts";
import { readText, writePrivate } from "./fs.ts";
import type { Secret } from "./secret.ts";

// Edits KEY=value lines in a dotenv file without touching anything else in it: comments, ordering
// and keys Sikrets doesn't own stay as they are. The file is owner-only and git-ignored.

const quote = (v: string) => JSON.stringify(v);
const keyOf = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];

export async function upsertEnv(root: string, file: string, entries: ReadonlyMap<string, Secret>) {
  const path = `${root}/${file}`;
  const lines = ((await readText(path)) ?? "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const pending = new Map(entries);
  const next = lines.map((line) => {
    const key = keyOf(line);
    const value = key ? pending.get(key) : undefined;
    if (!key || !value) return line;
    pending.delete(key);
    return `${key}=${quote(value.reveal())}`;
  });
  for (const [key, value] of pending) next.push(`${key}=${quote(value.reveal())}`);
  await ensureGitignore(root, [file]);
  await writePrivate(path, next.join("\n") + "\n");
}

export async function removeEnv(root: string, file: string, keys: readonly string[]) {
  const path = `${root}/${file}`;
  const current = await readText(path);
  if (current === undefined) return;
  const drop = new Set(keys);
  const kept = current.split(/\r?\n/).filter((line) => {
    const key = keyOf(line);
    return !(key && drop.has(key));
  });
  await writePrivate(path, kept.join("\n").replace(/\n*$/, "\n"));
}
