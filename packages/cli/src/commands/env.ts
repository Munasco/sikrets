import { upsertEnv } from "../core/dotenv.ts";
import { projectContext } from "../core/config.ts";
import { state } from "../core/state.ts";
import { envValues, outputKeys } from "../core/standin.ts";
import { record } from "../core/activity.ts";
import { requireOwner } from "../core/doorman.ts";
import { openVault } from "../core/vault.ts";
import { recordUse } from "../core/usage.ts";
import { loadDataKey } from "../core/datakey.ts";
import { projectKey } from "../core/envelope.ts";
import { Secret } from "../core/secret.ts";
import { ENV } from "../constants.ts";

// `sikrets env` lists which values exist (names only, never values).
// `sikrets env pull` writes them into a git-ignored, owner-only env file: stand-ins for secrets by
// default, so the file is safe to have lying around; `--real` writes the real secrets instead, only
// after the Mac's owner authenticates. `--project-key` adds SIKRETS_PROJECT_KEY: what a deployed
// app's SDK needs to open this project's sealed values (it opens this project only, not others).
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { resources } = await state.load(root);
  const { config, ctx } = await projectContext(root, { log: () => {} });
  const vault = await openVault(ctx.project, ctx.vault);
  const applied = resources.filter((r) => r.applied);

  if (args[0] === "pull") {
    const file = typeof opts.file === "string" ? opts.file : config.env;
    const real = Boolean(opts.real);
    const withKey = Boolean(opts["project-key"]);
    if (real || withKey) await requireOwner(withKey ? `write this project's key to ${file}` : `write real secrets to ${file}`);
    const values = await envValues(vault, applied, real);
    if (withKey) {
      const dataKey = await loadDataKey();
      if (!dataKey) throw new Error("This device doesn't have your data key. Restore it with: sikrets recovery restore");
      values.set(ENV.project, Secret.of(ctx.project));
      values.set(ENV.projectKey, Secret.of(projectKey(dataKey, ctx.project).toString("base64")));
    }
    await upsertEnv(root, file, values);
    await record(root, { kind: "env.pull", detail: `${values.size} value(s) to ${file}`, keys: [...values.keys()], real });
    const sensitive = applied.flatMap(outputKeys).filter((k) => k.sensitive && values.has(k.key)).map((k) => k.key);
    // Stand-ins aren't keys; only a --real pull hands keys out.
    if (real) await recordUse(ctx.project, { keys: sensitive, via: "env.pull", app: file });
    const secrets = sensitive.length;
    const what = real ? `${secrets} real secret(s)` : `${secrets} stand-in(s)`;
    if (withKey) await record(root, { kind: "reveal", detail: "env pull --project-key", keys: [ENV.projectKey] });
    return console.log(opts.json ? JSON.stringify({ file, keys: values.size, real }) : `Wrote ${values.size} value(s) to ${file}: ${what} (mode 600, git-ignored).`);
  }
  if (args[0]) throw new Error(`Unknown env subcommand "${args[0]}". Use: sikrets env, sikrets env pull [--real]`);

  const rows = await Promise.all(
    applied.flatMap(outputKeys).map(async ({ key, sensitive }) => ({ key, sensitive, set: await vault.has(key) })),
  );
  if (opts.json) return console.log(JSON.stringify({ vault: vault.name, keys: rows }));
  if (!rows.length) return console.log("No values yet. Add something: sikrets add <provider/service>");
  console.log(`Values in the ${vault.name} vault (names only):`);
  for (const r of rows) console.log(`  ${r.set ? "●" : "○"} ${r.key}${r.sensitive ? "  secret · .env holds a stand-in" : ""}${r.set ? "" : "  (missing)"}`);
}
