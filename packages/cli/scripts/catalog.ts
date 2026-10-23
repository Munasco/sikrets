// Builds src/catalog/providers.json from the Terraform Registry: every official and partner
// provider, ranked by downloads. Re-run to pick up new providers and version changes:
//   bun scripts/catalog.ts [limit]
import type { CatalogProvider } from "../src/catalog/types.ts";

const LIMIT = Number(Bun.argv[2] ?? 200);
const REGISTRY = "https://registry.terraform.io";

interface RegistryProvider {
  attributes: {
    "full-name": string;
    name: string;
    alias: string | null;
    namespace: string;
    description: string | null;
    downloads: number;
    tier: "official" | "partner" | "community";
    source: string;
  };
}

async function fetchTier(tier: "official" | "partner"): Promise<RegistryProvider[]> {
  const all: RegistryProvider[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${REGISTRY}/v2/providers?filter%5Btier%5D=${tier}&page%5Bsize%5D=100&page%5Bnumber%5D=${page}`);
    if (!res.ok) throw new Error(`Registry ${tier} page ${page}: HTTP ${res.status}`);
    const body = (await res.json()) as { data: RegistryProvider[]; meta: { pagination: { "next-page": number | null } } };
    all.push(...body.data);
    if (!body.meta.pagination["next-page"]) return all;
  }
}

// Terraform utilities: no account, no credentials, nothing for Sikrets to connect to.
// Developer services that matter for apps and agents but are community-tier in the registry.
// Each address was checked against the registry; the script drops any that disappear.
const CURATED = [
  "upstash/upstash", "supabase/supabase", "kislerdm/neon", "planetscale/planetscale", "mongodb/mongodbatlas",
  "terraform-community-providers/railway", "jianyuan/sentry", "netlify/netlify", "celest-dev/turso", "twilio/twilio",
  "jianyuan/openai", "fly-apps/fly", "vercel/vercel", "prisma/prisma-postgres", "stripe/stripe", "posthog/posthog",
  "launchdarkly/launchdarkly", "algolia/algolia", "elastic/ec", "auth0/auth0", "render-oss/render", "pinecone-io/pinecone",
  "koyeb/koyeb", "aiven/aiven", "grafana/grafana", "confluentinc/confluent", "heroku/heroku", "digitalocean/digitalocean",
  "cloudflare/cloudflare", "hashicorp/aws",
];

async function fetchCurated(): Promise<CatalogProvider[]> {
  const found = await Promise.all(
    CURATED.map(async (address) => {
      const res = await fetch(`${REGISTRY}/v1/providers/${address}`);
      if (!res.ok) return void console.warn(`skipped ${address}: HTTP ${res.status}`);
      const a = (await res.json()) as { namespace: string; name: string; alias: string | null; description: string; downloads: number; tier: CatalogProvider["tier"]; source: string };
      return { id: a.alias ?? a.name, name: a.alias ?? a.name, terraform: address, tier: a.tier, description: firstSentence(a.description), downloads: a.downloads, repository: a.source, curated: true };
    }),
  );
  return found.filter((p): p is CatalogProvider => p !== undefined);
}

const UTILITIES = new Set(["random", "null", "time", "local", "template", "external", "archive", "http", "cloudinit", "tls", "dns", "terraform", "tfe", "tfmigrate", "hcp", "assert", "awscc", "google-beta"]);

const firstSentence = (text: string | null) => (text ?? "").replace(/\s+/g, " ").split(/(?<=\.)\s/)[0]!.slice(0, 160);

const curated = await fetchCurated();
const ranked: CatalogProvider[] = [...(await fetchTier("official")), ...(await fetchTier("partner"))]
  .map(({ attributes: a }) => ({
    id: a.alias ?? a.name,
    name: a.alias ?? a.name,
    terraform: a["full-name"],
    tier: a.tier as "official" | "partner",
    description: firstSentence(a.description),
    downloads: a.downloads,
    repository: a.source,
    curated: false,
  }))
  .filter((p) => !(p.terraform.startsWith("hashicorp/") && UTILITIES.has(p.name)))
  .sort((x, y) => y.downloads - x.downloads);

// Curated entries win their id; ranked entries fill the rest. Two namespaces can publish the same
// short name, so each id keeps only its first (curated, then most downloaded) provider.
const providers = [...curated, ...ranked]
  .filter((p, i, list) => list.findIndex((q) => q.id === p.id) === i)
  .slice(0, Math.max(LIMIT, curated.length))
  .sort((x, y) => Number(y.curated) - Number(x.curated) || y.downloads - x.downloads);

await Bun.write(new URL("../src/catalog/providers.json", import.meta.url), JSON.stringify(providers, null, 1) + "\n");
console.log(`Wrote ${providers.length} providers (${curated.length} curated, ${providers.filter((p) => p.tier === "official").length} official).`);
