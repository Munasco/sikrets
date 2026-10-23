import { state } from "../core/state.ts";
import { service } from "../services.ts";

// Month-to-date spend for everything Sikrets provisioned in this project, read from each provider.
export async function run(_args: string[], opts: Record<string, string | boolean | undefined>) {
  const { resources } = await state.load(process.cwd());
  if (!resources.length) return console.log(opts.json ? "[]" : "Nothing provisioned in this project yet.");
  const rows = await Promise.all(
    resources.map(async (r) => {
      const svc = await service(`${r.provider}/${r.service}`);
      const spent = await svc.cost(r).catch(() => undefined);
      return { id: r.id, plan: r.plan, budget: r.budget, monthToDate: spent };
    }),
  );
  if (opts.json) return console.log(JSON.stringify(rows));
  const money = (n?: number) => (n === undefined ? "unavailable" : `$${n.toFixed(2)}`);
  for (const r of rows) console.log(`${r.id.padEnd(28)} ${(r.plan ?? "").padEnd(12)} ${money(r.monthToDate).padStart(12)}${r.budget ? `  of $${r.budget} cap` : ""}`);
  const total = rows.reduce((t, r) => t + (r.monthToDate ?? 0), 0);
  console.log(`${"total this month".padEnd(41)} ${money(total).padStart(12)}`);
}
