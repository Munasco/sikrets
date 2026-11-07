import { projectContext } from "../core/config.ts";
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
  const root = process.cwd();
  const { ctx } = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: (m) => log(opts, m) });
  const ops = await journal.load(root);
  // Without an id: the newest operation not fully rolled back, including one a crash left running
  // or a rollback that stopped midway (it resumes from the first step not yet undone).
  const op = args[0] ? ops.find((o) => o.id === args[0]) : ops.filter((o) => o.status !== "rolled-back").at(-1);
  if (!op) throw new Error(args[0] ? `No operation ${args[0]} in .sikrets/journal.json` : "Nothing to roll back");
  if (op.status === "rolled-back") throw new Error(`${op.id} was already rolled back at ${op.rolledBackAt}`);
  await assertSafe(root, op, ops);

  const resuming = op.status === "rolling-back" ? " (resuming an unfinished rollback)" : op.status === "running" ? " (it didn't finish)" : "";
  log(opts, `${ctx.dryRun ? "Dry run — would undo" : "Undoing"} ${op.id} (${op.command}, ${op.at})${resuming}:`);
  if (ctx.dryRun) {
    await undoSteps(op, ctx);
    if (opts.json) console.log(JSON.stringify({ dryRun: true, operation: op.id, steps: [...op.steps].reverse().filter((s) => s.status !== "undone").map((s) => s.summary) }));
    return;
  }
  if (!opts.yes && process.stdin.isTTY && !(await confirm(op.command === "apply" ? "Destroy these resources in the cloud?" : "Roll back?"))) return log(opts, "Cancelled.");
  await undoSteps(op, ctx);
  await record(root, { kind: "rollback", detail: `${op.id} (${op.command})` });
  if (opts.json) console.log(JSON.stringify({ operation: op.id, rolledBack: true }));
  else log(opts, `Rolled back ${op.id}.`);
}

/** Refuses undos that would orphan cloud resources or break something that depends on them. */
async function assertSafe(root: string, op: Operation, ops: readonly Operation[]) {
  const removing = op.steps.filter((s) => s.kind === "state.remove" && s.status !== "undone").map((s) => s.data.name!);
  if (!removing.length) return;
  const { resources } = await state.load(root);
  // API resources are deleted by this op's own steps; Terraform ones need their apply rolled back
  // first. An apply that hasn't been rolled back counts even if it crashed before state said "live".
  const applying = new Set(
    ops
      .filter((o) => o.command === "apply" && o.status !== "rolled-back")
      .flatMap((o) => o.steps.filter((s) => s.kind === "terraform.destroy" && s.status !== "undone").flatMap((s) => s.data.names!.split(","))),
  );
  const live = resources.filter((r) => removing.includes(r.name) && r.strategy === "terraform" && (r.applied || applying.has(r.name))).map((r) => r.name);
  if (live.length) throw new Error(`${live.join(", ")} still exist in the cloud. Roll back the apply first (sikrets rollback), then this add.`);
  const dependents = resources.filter((r) => !removing.includes(r.name) && Object.values(r.dependsOn).some((d) => removing.includes(d)));
  if (dependents.length) throw new Error(`${dependents.map((d) => d.name).join(", ")} depend on ${removing.join(", ")}. Roll those back first.`);
}
