import providers from "../catalog/providers.json";
import type { CatalogProvider } from "../catalog/types.ts";
import { recipes } from "../recipes/index.ts";

// Search the provider catalog (200 providers from the Terraform Registry) and what's addable today.
export async function run(args: string[], opts: Record<string, unknown>) {
  const words = args.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  const recipesOf = (id: string) => [...recipes.values()].filter((r) => r.provider === id);
  const addable = (id: string) => recipesOf(id).map((r) => r.id);
  const haystack = (p: CatalogProvider) => [p.id, p.terraform, p.description, ...recipesOf(p.id).map((r) => `${r.id} ${r.summary}`)].join(" ").toLowerCase();
  const matches = (providers as CatalogProvider[]).filter((p) => words.every((w) => haystack(p).includes(w)));

  if (opts.json) return console.log(JSON.stringify(matches.map((p) => ({ ...p, addable: addable(p.id) }))));
  if (!matches.length) return console.log("No providers match.");
  const width = Math.max(...matches.map((p) => p.id.length));
  for (const p of matches.slice(0, words.length ? 50 : 30)) {
    const add = addable(p.id);
    console.log(`${p.id.padEnd(width)}  ${p.terraform.padEnd(36)} ${add.length ? `add: ${add.join(", ")}` : p.description.slice(0, 70)}`);
  }
  if (matches.length > (words.length ? 50 : 30)) console.log(`… ${matches.length - (words.length ? 50 : 30)} more. Narrow it: sikrets catalog <words>`);
}
