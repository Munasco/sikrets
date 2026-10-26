// Builds src/catalog/services.json: every service Sikrets can store a key for, from sources we're
// free to use:
//   - src/catalog/saas.json, our hand-checked list (wins on every fact it has),
//   - src/catalog/researched.json, services we looked up in each provider's own docs; only
//     confirmed entries carry auth details, and a key check only when nothing but the key is needed,
//   - the APIs.guru OpenAPI directory (CC0): how each API authenticates, and a cheap GET to check a key,
//   - the Terraform Registry: providers with real usage, for coverage and the Terraform address.
// Re-run to refresh:  bun scripts/services.ts
import type { Service, ServiceAuth } from "../src/catalog/services.ts";

const GURU = "https://api.apis.guru/v2/list.json";
const REGISTRY = "https://registry.terraform.io";
/** Community Terraform providers below this many downloads are mostly forks and experiments. */
const MIN_COMMUNITY_DOWNLOADS = 5_000;
const CONCURRENCY = 12;
const TIMEOUT_MS = 30_000;

// Terraform providers with no account behind them: nothing to keep a key for.
const UTILITIES = new Set([
  "random", "null", "time", "local", "template", "external", "archive", "http", "cloudinit", "tls", "dns", "terraform",
  "assert", "awscc", "google-beta", "kubernetes", "helm", "docker", "shell", "restapi", "rest", "ssh", "sops", "git",
  "github-actions", "jq", "utils", "toolbox", "string-functions", "ignition", "ct", "kubectl", "kustomization", "kind",
  "k3d", "minikube", "libvirt", "lxd", "incus", "proxmox", "vsphere", "nsxt", "ansible", "pass", "remote", "acme", "env",
  "pkcs12", "jwt", "htpasswd", "macaddress", "dotenv", "context", "corefunc", "provider-functions",
]);

/** Names that are tooling around Terraform, not a service with an account. */
const NOT_A_SERVICE = /(helper|util|function|merge|calc|generator|example|demo|test|mock|fake|dummy|local|template|playground|sandbox|tools?$|^terra|^tf|json|yaml|toml|hcl|string|math|ipam|wireguard|libvirt|vmware|vsphere|esxi|proxmox|azurerm.+|aws.+|google.+)/;

interface Researched {
  name: string;
  confidence: "high" | "medium" | "low";
  website?: string;
  docs?: string;
  auth: ServiceAuth;
  header?: string;
  query?: string;
  verify?: string;
}

/** "Loops.so" → "loops", "Discord Bot" → "discord-bot". */
const researchedId = (name: string) => slug(name.replace(/\.(so|io|ai|com|app|co|org|net|me|dev)$/i, ""));

interface SaasEntry {
  id: string;
  name: string;
  category: string;
  docs: string;
  terraform: string | null;
  auth: string;
}

type Spec = {
  servers?: { url: string }[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  security?: Record<string, string[]>[];
  components?: { securitySchemes?: Record<string, SecurityScheme> };
  securityDefinitions?: Record<string, SecurityScheme>;
  paths?: Record<string, Record<string, Operation>>;
};
type SecurityScheme = { type: string; in?: string; name?: string; scheme?: string };
type Operation = { parameters?: { in?: string; required?: boolean; $ref?: string }[]; security?: Record<string, string[]>[] };

const slug = (s: string) =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/, "");

const fetchJson = async <T>(url: string): Promise<T | undefined> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
};

async function pool<T>(items: T[], run: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let it = queue.shift(); it !== undefined; it = queue.shift()) await run(it);
  }));
}

// ── APIs.guru ──────────────────────────────────────────────────────────────

/** "stripe.com" → "stripe", "api.video" → "api-video", "amazonaws.com:s3" stays one provider. */
function guruId(provider: string): string {
  const parts = provider.replace(/^(api|www|developer|developers)\./, "").split(".");
  const base = parts.length > 1 && parts.at(-1)!.length <= 3 && parts.at(-2) !== "api" ? parts.slice(0, -1) : parts;
  return slug(base.join("-"));
}

function authOf(spec: Spec): Pick<Service, "auth" | "header" | "query"> {
  const schemes = Object.values(spec.components?.securitySchemes ?? spec.securityDefinitions ?? {});
  const key = schemes.find((s) => s.type === "apiKey" && s.name && (s.in === "header" || s.in === "query"));
  const bearer = schemes.find((s) => s.type === "http" && s.scheme?.toLowerCase() === "bearer");
  const basic = schemes.find((s) => (s.type === "http" && s.scheme?.toLowerCase() === "basic") || s.type === "basic");
  const oauth = schemes.find((s) => s.type === "oauth2" || s.type === "openIdConnect");
  if (bearer) return { auth: "bearer" };
  if (key?.in === "header" && /^authorization$/i.test(key.name!)) return { auth: "bearer" };
  if (key?.in === "header") return { auth: "header", header: key.name };
  if (key?.in === "query") return { auth: "query", query: key.name };
  if (basic) return { auth: "basic" };
  if (oauth) return { auth: "oauth" };
  return { auth: "unknown" };
}

function baseUrl(spec: Spec): string | undefined {
  const server = spec.servers?.[0]?.url ?? (spec.host ? `${spec.schemes?.includes("https") || !spec.schemes ? "https" : spec.schemes[0]}://${spec.host}${spec.basePath ?? ""}` : undefined);
  if (!server || !/^https:\/\/[^{}]+$/.test(server)) return undefined;
  return server.replace(/\/$/, "");
}

/** A GET with no path or required parameters, preferring "who am I" style endpoints: cheap and read-only. */
function verifyPath(spec: Spec): string | undefined {
  const candidates = Object.entries(spec.paths ?? {}).filter(([p, ops]) => {
    const get = ops.get;
    if (!get || p.includes("{")) return false;
    return !(get.parameters ?? []).some((x) => x.required && x.in !== "header");
  });
  const score = (p: string) => (/\b(me|whoami|user|account|ping|status|self)\b/i.test(p) ? 0 : 1) * 1000 + p.length;
  return candidates.map(([p]) => p).sort((a, b) => score(a) - score(b))[0];
}

async function fromGuru(): Promise<Service[]> {
  const list = (await fetchJson<Record<string, { preferred: string; versions: Record<string, { swaggerUrl: string; info: Record<string, unknown> }> }>>(GURU))!;
  // One API per provider: the one named after the provider itself, else the first.
  const byProvider = new Map<string, string>();
  for (const id of Object.keys(list)) {
    const provider = id.split(":")[0]!;
    if (!byProvider.has(provider) || id === provider) byProvider.set(provider, id);
  }
  const out: Service[] = [];
  await pool([...byProvider], async ([provider, apiId]) => {
    const entry = list[apiId]!;
    const version = entry.versions[entry.preferred]!;
    const info = version.info as { title?: string; contact?: { url?: string }; "x-apisguru-categories"?: string[]; externalDocs?: { url?: string } };
    const spec = await fetchJson<Spec>(version.swaggerUrl);
    if (!spec) return;
    const auth = authOf(spec);
    if (auth.auth === "unknown") return; // open APIs need no key
    // Only send a key to the provider's own domain, never to a mock or third-party host in the spec.
    const domain = provider.split(":")[0]!;
    const base = [baseUrl(spec)].find((b) => b && (new URL(b).hostname === domain || new URL(b).hostname.endsWith(`.${domain}`)));
    const path = auth.auth === "oauth" || auth.auth === "basic" ? undefined : verifyPath(spec);
    const name = (info.title ?? provider).replace(/\s+(REST\s+)?API(\s+v?\d.*)?$/i, "").trim() || provider;
    out.push({
      id: guruId(provider),
      name,
      category: info["x-apisguru-categories"]?.[0] ?? "other",
      ...auth,
      ...(info.contact?.url?.startsWith("https://") ? { website: info.contact.url } : {}),
      ...(base && path ? { verify: `${base}${path}` } : {}),
      sources: ["apis.guru"],
    });
  });
  return out;
}

// ── Terraform Registry ─────────────────────────────────────────────────────

interface RegistryProvider {
  attributes: { "full-name": string; name: string; alias: string | null; description: string | null; downloads: number; tier: string };
}

async function fromTerraform(): Promise<Service[]> {
  const all: RegistryProvider[] = [];
  for (const tier of ["official", "partner", "community"]) {
    for (let page = 1; ; page++) {
      const body = await fetchJson<{ data: RegistryProvider[]; meta: { pagination: { "next-page": number | null } } }>(
        `${REGISTRY}/v2/providers?filter%5Btier%5D=${tier}&page%5Bsize%5D=100&page%5Bnumber%5D=${page}`,
      );
      if (!body) throw new Error(`Terraform Registry ${tier} page ${page} failed`);
      all.push(...body.data);
      if (!body.meta.pagination["next-page"]) break;
    }
  }
  // Many namespaces publish forks under one name; keep the most downloaded of each.
  const best = new Map<string, RegistryProvider>();
  for (const p of all) {
    const a = p.attributes;
    const id = slug(a.alias ?? a.name);
    if (UTILITIES.has(id) || (a.tier === "community" && NOT_A_SERVICE.test(id))) continue;
    if (a.tier === "community" && a.downloads < MIN_COMMUNITY_DOWNLOADS) continue;
    const cur = best.get(id);
    const rank = (x: RegistryProvider) => (x.attributes.tier === "community" ? 0 : 1e15) + x.attributes.downloads;
    if (!cur || rank(p) > rank(cur)) best.set(id, p);
  }
  return [...best].map(([id, p]) => ({
    id,
    name: p.attributes.alias ?? p.attributes.name,
    category: "other",
    auth: "unknown" as ServiceAuth,
    terraform: p.attributes["full-name"],
    // The provider's docs say how the service authenticates and where its keys come from.
    docs: `${REGISTRY}/providers/${p.attributes["full-name"]}/latest/docs`,
    sources: ["terraform"],
  }));
}

// ── Merge ──────────────────────────────────────────────────────────────────

const AUTH_FROM_SAAS: Record<string, ServiceAuth> = { "api-key": "header", bearer: "bearer", basic: "basic", oauth: "oauth" };

async function main() {
  const saas = (await Bun.file(new URL("../src/catalog/saas.json", import.meta.url)).json()) as SaasEntry[];
  const researched = (await Bun.file(new URL("../src/catalog/researched.json", import.meta.url)).json()) as Researched[];
  const [guru, tf] = await Promise.all([fromGuru(), fromTerraform()]);
  const merged = new Map<string, Service>();
  const add = (s: Service) => {
    const cur = merged.get(s.id);
    if (!cur) return void merged.set(s.id, s);
    // Earlier sources win each fact; later ones only fill gaps.
    merged.set(s.id, { ...s, ...cur, auth: cur.auth !== "unknown" ? cur.auth : s.auth, sources: [...new Set([...cur.sources, ...s.sources])] });
  };
  for (const e of saas) {
    add({ id: e.id, name: e.name, category: e.category, auth: AUTH_FROM_SAAS[e.auth] ?? "unknown", docs: e.docs, ...(e.terraform ? { terraform: e.terraform } : {}), sources: ["sikrets"] });
  }
  for (const r of researched) {
    const { confidence: _, name, ...facts } = r;
    add({ id: researchedId(name), name, category: "other", ...facts, sources: ["researched"] });
  }
  // The hand-checked list knows the auth style but not the header name; take that from the spec.
  for (const g of guru) {
    const cur = merged.get(g.id);
    if (cur?.sources.includes("sikrets") && g.auth === "header" && cur.auth === "header") merged.set(g.id, { ...cur, header: g.header, ...(g.verify ? { verify: g.verify } : {}) });
    add(g);
  }
  for (const t of tf) add(t);

  const services = [...merged.values()]
    .map((s) => (s.auth === "header" && !s.header ? { ...s, auth: "unknown" as ServiceAuth } : s))
    .sort((a, b) => a.id.localeCompare(b.id));
  await Bun.write(new URL("../src/catalog/services.json", import.meta.url), `${JSON.stringify(services)}\n`);
  const count = (f: (s: Service) => boolean) => services.filter(f).length;
  console.log(`Wrote ${services.length} services: ${count((s) => s.sources.includes("sikrets"))} hand-checked, ${count((s) => s.sources.includes("researched"))} researched, ${count((s) => s.sources.includes("apis.guru"))} from APIs.guru, ${count((s) => s.sources.includes("terraform"))} from Terraform; ${count((s) => !!s.verify)} with a live key check.`);
}

await main();
