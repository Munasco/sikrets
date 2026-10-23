import { providerEnv } from "../core/credentials.ts";
import { registerUndo, type Context } from "../core/plan.ts";
import { journal, projectName, state } from "../core/state.ts";
import { sync } from "../core/sync.ts";
import { terraform } from "../core/terraform.ts";
import { openVault } from "../core/vault.ts";
import { tfIdent } from "../recipes/types.ts";
import { log } from "../ui.ts";

// Creates (or updates) everything declared in iac/terraform, then publishes outputs to the vault.
export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const project = projectName(root);
  const resources = (await state.load(root)).resources.filter((r) => r.strategy === "terraform");
  if (!resources.length) throw new Error("No Terraform resources to apply. API-backed services are created by sikrets add directly.");

  const env = await providerEnv(resources.map((r) => r.provider));
  const pending = resources.filter((r) => !r.applied).map((r) => r.name);
  log(opts, `Applying ${resources.length} resource(s)${pending.length ? `; new: ${pending.join(", ")}` : ""}`);

  await terraform(root, ["init", "-input=false"], env);
  if (opts["dry-run"]) return terraform(root, ["plan", "-input=false"], env);
  await terraform(root, ["apply", "-input=false", ...(opts.yes ? ["-auto-approve"] : [])], env);

  const result = await sync(root, project, env);
  if (pending.length) {
    await journal.record(root, {
      id: `op_${Date.now().toString(36)}`,
      command: "apply",
      at: new Date().toISOString(),
      steps: [{ kind: "terraform.destroy", summary: `Destroy ${pending.join(", ")} in the cloud`, data: { names: pending.join(",") } }],
    });
  }
  const summary = `Published ${result.values + result.secrets} value(s) to the vault (${result.secrets} secret). Use them with: sikrets run -- <command>`;
  if (opts.json) console.log(JSON.stringify(result));
  else log(opts, summary);
}

registerUndo("terraform.destroy", async ({ names }, ctx: Context) => {
  const list = names!.split(",");
  const { resources } = await state.load(ctx.root);
  const targets = resources.filter((r) => list.includes(r.name));
  const env = await providerEnv(targets.map((r) => r.provider));
  await terraform(ctx.root, ["destroy", "-input=false", "-auto-approve", ...targets.map((r) => `-target=module.${tfIdent(r.name)}`)], env);
  const vault = await openVault(ctx.project);
  for (const r of targets) {
    for (const key of r.envKeys) await vault.delete(key);
    await state.upsert(ctx.root, { ...r, applied: false, outputs: {} });
  }
});
