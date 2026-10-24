import { personalDir, projectContext } from "../core/config.ts";
import { record } from "../core/activity.ts";
import { undoSteps } from "../core/plan.ts";
import { journal, state, type Operation } from "../core/state.ts";
import { confirm, log } from "../ui.ts";
// Modules that register the undo kinds the journal can contain.
import "../core/add.ts";
import "../core/files.ts";
import "../core/vault.ts";
import "./apply.ts";

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = opts.personal || opts.orphans ? personalDir() : process.cwd();
  const { ctx } = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: (m) => log(opts, m) });
  const ops = await journal.load(root);
  const op = args[0] ? ops.find((o) => o.id === args[0]) : ops.filter((o) => !o.rolledBackAt).at(-1);
  if (!op) throw new Error(args[0] ? `No operation ${args[0]} in .sikrets/journal.json` : "Nothing to roll back");
  if (op.rolledBackAt) throw new Error(`${op.id} was already rolled back at ${op.rolledBackAt}`);
  await assertSafe(root, op);

  log(opts, `${ctx.dryRun ? "Dry run — would undo" : "Undoing"} ${op.id} (${op.command}, ${op.at}):`);
  if (ctx.dryRun) {
    await undoSteps(op, ctx);
    if (opts.json) console.log(JSON.stringify({ dryRun: true, operation: op.id, steps: [...op.steps].reverse().map((s) => s.summary) }));
    return;
  }
  if (!opts.yes && process.stdin.isTTY && !(await confirm(op.command === "apply" ? "Destroy these resources in the cloud?" : "Roll back?"))) return log(opts, "Cancelled.");
  await undoSteps(op, ctx);
  op.rolledBackAt = new Date().toISOString();
  await journal.save(root, ops);
  await record(root, { kind: "rollback", detail: `${op.id} (${op.command})` });
  if (opts.json) console.log(JSON.stringify({ operation: op.id, rolledBack: true }));
  else log(opts, `Rolled back ${op.id}.`);
}

/** Refuses undos that would orphan cloud resources or break something that depends on them. */
async function assertSafe(root: string, op: Operation) {
  const removing = op.steps.filter((s) => s.kind === "state.remove").map((s) => s.data.name!);
  if (!removing.length) return;
  const { resources } = await state.load(root);
  // API resources are deleted by this op's own steps; Terraform ones need their apply rolled back first.
  const live = resources.filter((r) => removing.includes(r.name) && r.strategy === "terraform" && r.applied).map((r) => r.name);
  if (live.length) throw new Error(`${live.join(", ")} still exist in the cloud. Roll back the apply first (sikrets rollback), then this add.`);
  const dependents = resources.filter((r) => !removing.includes(r.name) && Object.values(r.dependsOn).some((d) => removing.includes(d)));
  if (dependents.length) throw new Error(`${dependents.map((d) => d.name).join(", ")} depend on ${removing.join(", ")}. Roll those back first.`);
}
