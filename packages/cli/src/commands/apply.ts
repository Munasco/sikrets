import { providerEnv } from "../core/credentials.ts";
import { registerUndo, type Context } from "../core/plan.ts";
import { projectContext } from "../core/config.ts";
import { record } from "../core/activity.ts";
import { journal, markStep, newOperation, state, transition } from "../core/state.ts";
import { sync } from "../core/sync.ts";
import { terraform } from "../core/terraform.ts";
import { openVault, type VaultName } from "../core/vault.ts";
import { tfIdent } from "../recipes/types.ts";
import { log } from "../ui.ts";

// Creates (or updates) everything declared in iac/terraform, then publishes outputs to the vault.
export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { ctx } = await projectContext(root, { log: (m) => log(opts, m) });
  const resources = (await state.load(root)).resources.filter((r) => r.strategy === "terraform");
  if (!resources.length) throw new Error("No Terraform resources to apply. API-backed services are created by sikrets add directly.");

  const env = await providerEnv(resources.map((r) => r.provider));
  const pending = resources.filter((r) => !r.applied).map((r) => r.name);
  log(opts, `Applying ${resources.length} resource(s)${pending.length ? `; new: ${pending.join(", ")}` : ""}`);

  await terraform(root, ["init", "-input=false"], env);
  if (opts["dry-run"]) return terraform(root, ["plan", "-input=false"], env);

  // Journal the undo before terraform creates anything: if apply or the vault sync after it fails
  // (or the process dies), the new cloud resources still have a rollback record. An earlier apply
  // that never finished is continued rather than duplicated.
  const unfinished = (await journal.load(root)).filter((o) => o.command === "apply" && o.status === "running").at(-1);
  const names = [...new Set([...(unfinished?.steps.flatMap((s) => s.data.names!.split(",")) ?? []), ...pending])];
  const op = names.length ? (unfinished ?? newOperation("apply")) : undefined;
  if (op) {
    op.steps = [{ kind: "terraform.destroy", summary: `Destroy ${names.join(", ")} in the cloud`, data: { names: names.join(","), vault: ctx.vault }, status: "pending" }];
    await journal.record(root, op);
  }

  await terraform(root, ["apply", "-input=false", ...(opts.yes ? ["-auto-approve"] : [])], env);
  const result = await sync(root, ctx.project, ctx.vault, env);
  if (op) {
    markStep(op.steps[0]!, "done");
    transition(op, "applied");
    await journal.record(root, op);
  }
  await record(root, { kind: "apply", detail: `${resources.length} Terraform resource(s)${pending.length ? `, new: ${pending.join(", ")}` : ""}` });
  const summary = `Published ${result.values + result.secrets} value(s) to the vault (${result.secrets} secret). Use them with: sikrets run -- <command>`;
  if (opts.json) console.log(JSON.stringify(result));
  else log(opts, summary);
}

registerUndo("terraform.destroy", async ({ names, vault: vaultName }, ctx: Context) => {
  const list = names!.split(",");
  const { resources } = await state.load(ctx.root);
  const targets = resources.filter((r) => list.includes(r.name));
  if (!targets.length) return;
  const env = await providerEnv(targets.map((r) => r.provider));
  await terraform(ctx.root, ["destroy", "-input=false", "-auto-approve", ...targets.map((r) => `-target=module.${tfIdent(r.name)}`)], env);
  for (const r of targets) {
    const vault = await openVault(ctx.project, r.vault ?? (vaultName as VaultName | undefined) ?? ctx.vault);
    for (const key of r.envKeys) await vault.delete(key);
    await state.patch(ctx, r.name, (cur) => ({ ...cur, applied: false, outputs: {} }));
  }
});
