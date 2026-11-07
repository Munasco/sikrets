import { upsertEnv } from "../core/dotenv.ts";
import { projectContext } from "../core/config.ts";
import { state } from "../core/state.ts";
import { envValues, outputKeys } from "../core/standin.ts";
import { record } from "../core/activity.ts";
import { vaults } from "../core/vault.ts";
import type { Resource } from "../core/state.ts";

// `sikrets env` lists which values exist (names only, never values).
// `sikrets env pull` writes them into a git-ignored, owner-only env file: stand-ins for secrets by
// default, so the file is safe to have lying around; `--real` writes the real secrets instead.
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { resources } = await state.load(root);
  const { config, ctx } = await projectContext(root, { log: () => {} });
  const open = vaults(ctx.project);
  // Each resource's values live in the vault they were stored in (SIKRETS_VAULT may differ now).
  const vaultOf = (r: Resource) => open(r.vault ?? ctx.vault);
  const applied = resources.filter((r) => r.applied);

  if (args[0] === "pull") {
    const file = typeof opts.file === "string" ? opts.file : config.env;
    const real = Boolean(opts.real);
    const values = await envValues(vaultOf, applied, real);
    await upsertEnv(root, file, values);
    await record(root, { kind: "env.pull", detail: `${values.size} value(s) to ${file}`, keys: [...values.keys()], real });
    const secrets = applied.flatMap(outputKeys).filter((k) => k.sensitive && values.has(k.key)).length;
    const what = real ? `${secrets} real secret(s)` : `${secrets} stand-in(s)`;
    return console.log(opts.json ? JSON.stringify({ file, keys: values.size, real }) : `Wrote ${values.size} value(s) to ${file}: ${what} (mode 600, git-ignored).`);
  }
  if (args[0]) throw new Error(`Unknown env subcommand "${args[0]}". Use: sikrets env, sikrets env pull [--real]`);

  const rows = (
    await Promise.all(
      applied.map(async (res) => {
        const v = await vaultOf(res);
        return Promise.all(outputKeys(res).map(async ({ key, sensitive }) => ({ key, sensitive, vault: v.name, set: (await v.get(key)) !== undefined })));
      }),
    )
  ).flat();
  if (opts.json) return console.log(JSON.stringify({ vault: ctx.vault, keys: rows }));
  if (!rows.length) return console.log("No values yet. Add something: sikrets add <provider/service>");
  console.log(`Values in the ${ctx.vault} vault (names only):`);
  for (const r of rows) console.log(`  ${r.set ? "●" : "○"} ${r.key}${r.sensitive ? "  secret · .env holds a stand-in" : ""}${r.vault !== ctx.vault ? `  (in the ${r.vault} vault)` : ""}${r.set ? "" : "  (missing)"}`);
}
