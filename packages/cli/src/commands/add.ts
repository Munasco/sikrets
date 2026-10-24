import { planAdd } from "../core/add.ts";
import { projectContext } from "../core/config.ts";
import { record } from "../core/activity.ts";
import { applyPlan, printPlan } from "../core/plan.ts";
import { parseExpiry } from "../core/schedule.ts";
import { recipe } from "../recipes/index.ts";
import { choose, confirm, log } from "../ui.ts";
import { readSecretInput } from "./secret-input.ts";

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { config, ctx } = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: (m) => log(opts, m) });
  const r = recipe(args[0]!);

  // Recipe inputs arrive as --set key=value; dependency choices as --use requirement=resource.
  const inputs = pairs(opts.set, "--set");
  const unknown = Object.keys(inputs).filter((k) => !(k in r.inputs));
  if (unknown.length) throw new Error(`${r.id} has no input ${unknown.join(", ")}. Inputs: ${Object.keys(r.inputs).join(", ") || "none"}`);
  const interactive = !opts.yes && process.stdin.isTTY === true;

  const plan = await planAdd(
    {
      recipe: r.id,
      name: typeof opts.name === "string" ? opts.name : (r.defaultName ?? r.id.split("/")[1]!),
      inputs,
      use: pairs(opts.use, "--use"),
      choose: async (question, options) => {
        if (!interactive) throw new Error(`${question} Pass --use to pick one of: ${options.join(", ")}`);
        return choose(question, options);
      },
      envFile: config.env,
      rotateEvery: config.rotateEvery,
      ...(typeof opts.expires === "string" ? { expires: parseExpiry(opts.expires) } : {}),
      autoRotate: opts["auto-rotate"] === true,
      secret: (prompt) => readSecretInput(opts, prompt),
    },
    ctx,
  );

  printPlan(plan.changes, ctx);
  if (ctx.dryRun) {
    if (opts.json) console.log(JSON.stringify({ dryRun: true, resources: plan.resources.map(({ name, recipe, inputs, dependsOn }) => ({ name, recipe, inputs, dependsOn })), changes: plan.changes.map(({ summary, cost }) => ({ summary, cost })) }));
    return;
  }
  if (interactive && !(await confirm("Write these files?"))) return log(opts, "Cancelled; nothing was written.");

  const op = await applyPlan(`add ${r.id}`, plan.changes, ctx);
  await record(root, { kind: "add", detail: plan.resources.map((x) => `${x.recipe} ${x.name}`).join(", "), keys: plan.resources.flatMap((x) => x.envKeys) });
  if (opts.json) console.log(JSON.stringify({ operation: op.id, resources: plan.resources.map((x) => x.name) }));
  else {
    const declared = plan.resources.filter((x) => x.strategy === "terraform").map((x) => x.name);
    log(opts, `Added (${op.id}).${declared.length ? ` ${declared.join(", ")} exist only as Terraform so far: run sikrets apply.` : " Use it with: sikrets run -- <command>"} Undo with: sikrets rollback`);
  }
}

function pairs(value: unknown, flag: string): Record<string, string> {
  const list = value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
  return Object.fromEntries(
    list.map((item) => {
      const i = item.indexOf("=");
      if (i <= 0) throw new Error(`${flag} expects key=value, got "${item}"`);
      return [item.slice(0, i), item.slice(i + 1)];
    }),
  );
}
