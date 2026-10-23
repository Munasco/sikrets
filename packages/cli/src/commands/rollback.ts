import { undoSteps, type Context } from "../core/plan.ts";
import { journal, projectName } from "../core/state.ts";
import { confirm, log } from "../ui.ts";
// Each module registers the undo kinds it produces.
import "../core/files.ts";
import "../core/vault.ts";
import "../providers/upstash/redis.ts";

export async function run(args: string[], opts: Record<string, string | boolean | undefined>) {
  const root = process.cwd();
  const ctx: Context = { root, project: projectName(root), dryRun: Boolean(opts["dry-run"]), log: (m) => log(opts, m) };
  const ops = await journal.load(root);
  const op = args[0] ? ops.find((o) => o.id === args[0]) : ops.filter((o) => !o.rolledBackAt).at(-1);
  if (!op) throw new Error(args[0] ? `No operation ${args[0]} in .sikrets/journal.json` : "Nothing to roll back");
  if (op.rolledBackAt) throw new Error(`${op.id} was already rolled back at ${op.rolledBackAt}`);

  log(opts, `${ctx.dryRun ? "Dry run — would undo" : "Undoing"} ${op.id} (${op.command}, ${op.at}):`);
  if (ctx.dryRun) {
    await undoSteps(op, ctx);
    if (opts.json) console.log(JSON.stringify({ dryRun: true, operation: op.id, steps: [...op.steps].reverse().map((s) => s.summary) }));
    return;
  }
  if (!opts.yes && process.stdin.isTTY && !(await confirm("Roll back? This deletes what the add created."))) return log(opts, "Cancelled.");
  await undoSteps(op, ctx);
  op.rolledBackAt = new Date().toISOString();
  await journal.save(root, ops);
  if (opts.json) console.log(JSON.stringify({ operation: op.id, rolledBack: true }));
  else log(opts, `Rolled back ${op.id}.`);
}
