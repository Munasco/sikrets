import { providerEnv } from "../core/credentials.ts";
import { state, type Resource } from "../core/state.ts";
import { recipe } from "../recipes/index.ts";

// Live month-to-date spend where the provider reports it per resource; otherwise the recipe's
// estimate, labelled as such. (AWS per-resource spend needs Cost Explorer tags: ManagedBy=sikrets.)
async function liveCost(r: Resource): Promise<number | undefined> {
  const rec = recipe(r.recipe);
  if (rec.strategy !== "api" || !rec.cost || !r.remoteId || !r.applied) return undefined;
  return rec.cost(await providerEnv([rec.provider]), r.remoteId).catch(() => undefined);
}

export async function run(_args: string[], opts: Record<string, unknown>) {
  const { resources } = await state.load(process.cwd());
  if (!resources.length) return console.log(opts.json ? "[]" : "Nothing in this project yet.");
  const rows = await Promise.all(
    resources.map(async (r) => ({
      name: r.name,
      recipe: r.recipe,
      live: r.applied,
      monthToDate: await liveCost(r),
      estimate: recipe(r.recipe).estimate(r.inputs),
    })),
  );
  if (opts.json) return console.log(JSON.stringify(rows));
  for (const r of rows) {
    const spend = r.monthToDate !== undefined ? `$${r.monthToDate.toFixed(2)} this month` : `est. ${r.estimate}`;
    console.log(`${r.name.padEnd(16)} ${r.recipe.padEnd(16)} ${(r.live ? "live" : "not applied").padEnd(12)} ${spend}`);
  }
  const total = rows.reduce((t, r) => t + (r.monthToDate ?? 0), 0);
  console.log(`\nReported spend this month: $${total.toFixed(2)}${rows.some((r) => r.monthToDate === undefined) ? " (plus the estimates above)" : ""}`);
}
