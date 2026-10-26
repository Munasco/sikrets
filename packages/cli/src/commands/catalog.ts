import { SERVICES, type Service } from "../catalog/services.ts";
import { recipes } from "../recipes/index.ts";

// Search every service Sikrets can keep a key for, and what `sikrets add` takes for each.
export async function run(args: string[], opts: Record<string, unknown>) {
  const words = args.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  // Hand-written recipes first, then the generic one every service has.
  const addable = (s: Service) => [...[...recipes.values()].filter((r) => r.provider === s.id).map((r) => r.id), ...(recipes.has(`${s.id}/api-key`) ? [] : [`${s.id}/api-key`])];
  const haystack = (s: Service) => [s.id, s.name, s.category, s.terraform ?? ""].join(" ").toLowerCase();
  // Hand-checked services first, then researched or spec-backed ones, then Terraform-only ones.
  const rank = (s: Service) => (s.sources.includes("sikrets") ? 0 : s.sources.includes("researched") || s.sources.includes("apis.guru") ? 1 : 2);
  const matches = SERVICES.filter((s) => words.every((w) => haystack(s).includes(w))).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

  if (opts.json) return console.log(JSON.stringify(matches.map((s) => ({ ...s, addable: addable(s) }))));
  if (!matches.length) return console.log("No services match.");
  const limit = words.length ? 50 : 30;
  const width = Math.min(Math.max(...matches.slice(0, limit).map((s) => s.name.length)), 28);
  for (const s of matches.slice(0, limit)) {
    console.log(`${s.name.slice(0, 28).padEnd(width)}  ${(s.verify ? "checked" : "").padEnd(8)} sikrets add ${addable(s).join(" | ")}`);
  }
  console.log(matches.length > limit ? `… ${matches.length - limit} more. Narrow it: sikrets catalog <words>` : `${SERVICES.length} services in all.`);
}
