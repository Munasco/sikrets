import path from "node:path";
import { ensureGitignore } from "../core/files.ts";
import { writePrivate } from "../core/fs.ts";
import { projectName, state } from "../core/state.ts";
import { openVault } from "../core/vault.ts";

// `sikrets env` lists which values exist (never the values). `sikrets env pull` writes them to a
// git-ignored, owner-only .env for tools that can't use `sikrets run`.
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { resources } = await state.load(root);
  const vault = await openVault(projectName(root));
  const keys = resources.filter((r) => r.applied).flatMap((r) => r.envKeys);

  if (args[0] === "pull") {
    const file = typeof opts.file === "string" ? opts.file : ".env";
    const lines: string[] = [];
    for (const key of keys) {
      const value = await vault.get(key);
      if (value) lines.push(`${key}=${JSON.stringify(value.reveal())}`);
    }
    await ensureGitignore(root, [file]);
    await writePrivate(path.resolve(root, file), lines.join("\n") + "\n");
    return console.log(opts.json ? JSON.stringify({ file, keys: lines.length }) : `Wrote ${lines.length} value(s) to ${file} (mode 600, git-ignored).`);
  }
  if (args[0]) throw new Error(`Unknown env subcommand "${args[0]}". Use: sikrets env, sikrets env pull`);

  const rows = await Promise.all(keys.map(async (key) => ({ key, set: (await vault.get(key)) !== undefined })));
  if (opts.json) return console.log(JSON.stringify({ vault: vault.name, keys: rows }));
  if (!rows.length) return console.log("No values yet. Add something: sikrets add <provider/service>");
  console.log(`Values in the ${vault.name} vault (shown by name only):`);
  for (const r of rows) console.log(`  ${r.set ? "●" : "○"} ${r.key}${r.set ? "" : "  (missing: run sikrets apply)"}`);
}
