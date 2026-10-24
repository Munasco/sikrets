import { lastUsed, readActivity } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { providerEnv } from "../core/credentials.ts";
import { state, type Resource } from "../core/state.ts";
import { until } from "../core/ttl.ts";
import { recipe } from "../recipes/index.ts";

// One view of the project: each resource, how it's provisioned, when its keys were last used, and
// what it costs (live where the provider reports it, otherwise the recipe's estimate).
async function spend(r: Resource): Promise<string> {
  const rec = recipe(r.recipe);
  if (rec.strategy === "api" && rec.cost && r.remoteId && r.applied) {
    const live = await rec.cost(await providerEnv([rec.provider]), r.remoteId).catch(() => undefined);
    if (live !== undefined) return `$${live.toFixed(2)} this month`;
  }
  return `est. ${rec.estimate(r.inputs)}`;
}

const ago = (iso?: string) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { ctx } = await projectContext(root, { log: () => {} });
  const { resources } = await state.load(root);
  const used = lastUsed(await readActivity(root));
  const rows = await Promise.all(
    resources.map(async (r) => {
      const last = r.envKeys.map((k) => used.get(k)).filter((x): x is string => Boolean(x)).sort().at(-1);
      return { name: r.name, recipe: r.recipe, strategy: r.strategy, live: r.applied, created: r.createdAt, lastUsed: last ?? null, rotateBy: r.rotateBy ?? null, keys: r.envKeys, spend: await spend(r) };
    }),
  );
  if (opts.json) return console.log(JSON.stringify({ project: ctx.project, vault: ctx.vault, resources: rows }));
  console.log(`Project ${ctx.project} · vault ${ctx.vault} · ${rows.length} resource(s)\n`);
  if (!rows.length) return console.log("Nothing here yet. Add something: sikrets add <provider/service>");
  const w = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(`${"NAME".padEnd(w)}  ${"RECIPE".padEnd(18)} ${"STATE".padEnd(12)} ${"CREATED".padEnd(10)} ${"LAST USED".padEnd(10)} ${"ROTATE".padEnd(14)} COST`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(w)}  ${r.recipe.padEnd(18)} ${(r.live ? "live" : "declared").padEnd(12)} ${ago(r.created).padEnd(10)} ${ago(r.lastUsed ?? undefined).padEnd(10)} ${(r.rotateBy ? until(r.rotateBy) : "—").padEnd(14)} ${r.spend}`);
  }
}
