import { applyPlan, printPlan, type Context } from "../core/plan.ts";
import { projectName } from "../core/state.ts";
import { service } from "../services.ts";
import { confirm, log } from "../ui.ts";

export async function run(args: string[], opts: Record<string, string | boolean | undefined>) {
  const root = process.cwd();
  const ctx: Context = { root, project: projectName(root), dryRun: Boolean(opts["dry-run"]), log: (m) => log(opts, m) };
  const svc = await service(args[0]!);
  const changes = await svc.plan(opts as Record<string, string | undefined>, ctx);

  printPlan(changes, ctx);
  if (ctx.dryRun) {
    if (opts.json) console.log(JSON.stringify({ dryRun: true, changes: changes.map(({ summary, cost }) => ({ summary, cost })) }));
    return;
  }
  if (!opts.yes && process.stdin.isTTY && !(await confirm("Apply?"))) return log(opts, "Cancelled; nothing was created.");

  const op = await applyPlan(`add ${args[0]}`, changes, ctx);
  if (opts.json) console.log(JSON.stringify({ operation: op.id, steps: op.steps.length }));
  else log(opts, `Done (${op.id}). Undo with: sikrets rollback ${op.id}`);
}
