import { upsertEnv } from "../core/dotenv.ts";
import { projectContext } from "../core/config.ts";
import { state } from "../core/state.ts";
import { envValues, outputKeys } from "../core/standin.ts";
import { openVault } from "../core/vault.ts";

// `sikrets env` lists which values exist (names only, never values).
// `sikrets env pull` writes them into a git-ignored, owner-only env file: stand-ins for secrets by
// default, so the file is safe to have lying around; `--real` writes the real secrets instead.
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { resources } = await state.load(root);
  const { config, ctx } = await projectContext(root, { log: () => {} });
  const vault = await openVault(ctx.project, ctx.vault);
  const applied = resources.filter((r) => r.applied);

  if (args[0] === "pull") {
    const file = typeof opts.file === "string" ? opts.file : config.env;
    const real = Boolean(opts.real);
    const values = await envValues(vault, applied, real);
    await upsertEnv(root, file, values);
    const secrets = applied.flatMap(outputKeys).filter((k) => k.sensitive && values.has(k.key)).length;
    const what = real ? `${secrets} real secret(s)` : `${secrets} stand-in(s)`;
    return console.log(opts.json ? JSON.stringify({ file, keys: values.size, real }) : `Wrote ${values.size} value(s) to ${file}: ${what} (mode 600, git-ignored).`);
  }
  if (args[0]) throw new Error(`Unknown env subcommand "${args[0]}". Use: sikrets env, sikrets env pull [--real]`);

  const rows = await Promise.all(
    applied.flatMap(outputKeys).map(async ({ key, sensitive }) => ({ key, sensitive, set: (await vault.get(key)) !== undefined })),
  );
  if (opts.json) return console.log(JSON.stringify({ vault: vault.name, keys: rows }));
  if (!rows.length) return console.log("No values yet. Add something: sikrets add <provider/service>");
  console.log(`Values in the ${vault.name} vault (names only):`);
  for (const r of rows) console.log(`  ${r.set ? "●" : "○"} ${r.key}${r.sensitive ? "  secret · .env holds a stand-in" : ""}${r.set ? "" : "  (missing)"}`);
}
