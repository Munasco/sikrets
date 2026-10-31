import { SERVICES as CATALOG, type Service as CatalogService } from "../../catalog/services.ts";

// Services the proxy can attach credentials for: a few hand-written ones with special cases
// (GitHub's git host, Anthropic's header), then every catalog service whose API hosts and key
// style are known. Anything not listed is tunnelled untouched, or refused with --only-services.

/** What the proxy puts on a request for one host. */
export interface Credential {
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface Service {
  id: string;
  name: string;
  /** Where to create a token, shown by `sikrets proxy add`. */
  tokenUrl: string;
  hosts: Record<string, (token: string) => Credential>;
  /** Env vars SDKs read the key from; the agent gets the session token in them, never the key. */
  env: string[];
}

const bearer = (token: string): Credential => ({ headers: { authorization: `Bearer ${token}` } });
const basic = (userPass: string): Credential => ({ headers: { authorization: `Basic ${Buffer.from(userPass).toString("base64")}` } });

const CURATED: readonly Service[] = [
  {
    id: "github",
    name: "GitHub",
    tokenUrl: "https://github.com/settings/personal-access-tokens",
    hosts: {
      "api.github.com": bearer,
      "uploads.github.com": bearer,
      // git over HTTPS sends Basic auth; GitHub accepts any username with a token as the password.
      "github.com": (token) => basic(`x-access-token:${token}`),
    },
    env: ["GITHUB_TOKEN", "GH_TOKEN"],
  },
  { id: "slack", name: "Slack", tokenUrl: "https://api.slack.com/apps", hosts: { "slack.com": bearer }, env: ["SLACK_BOT_TOKEN", "SLACK_TOKEN"] },
  {
    id: "anthropic",
    name: "Anthropic",
    tokenUrl: "https://platform.claude.com/settings/keys",
    hosts: { "api.anthropic.com": (token) => ({ headers: { "x-api-key": token } }) },
    env: ["ANTHROPIC_API_KEY"],
  },
  { id: "openai", name: "OpenAI", tokenUrl: "https://platform.openai.com/api-keys", hosts: { "api.openai.com": bearer }, env: ["OPENAI_API_KEY"] },
  { id: "resend", name: "Resend", tokenUrl: "https://resend.com/api-keys", hosts: { "api.resend.com": bearer }, env: ["RESEND_API_KEY"] },
  { id: "stripe", name: "Stripe", tokenUrl: "https://dashboard.stripe.com/apikeys", hosts: { "api.stripe.com": bearer }, env: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"] },
];

/** How a catalog service's key goes on a request, or undefined when the proxy can't do it from the key alone. */
function apply(s: CatalogService): ((token: string) => Credential) | undefined {
  switch (s.auth) {
    case "bearer":
      return bearer;
    case "header":
      return s.header ? (token) => ({ headers: { [s.header!.toLowerCase()]: token } }) : undefined;
    case "query":
      return s.query ? (token) => ({ query: { [s.query!]: token } }) : undefined;
    case "basic":
      // Stored as the full "user:password" unless the catalog says which half the key is.
      return (token) => basic(s.basic === "key:" ? `${token}:` : s.basic === ":key" ? `:${token}` : s.basic === "api:key" ? `api:${token}` : token);
    default:
      return undefined;
  }
}

const envName = (id: string) => `${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

function fromCatalog(s: CatalogService): Service | undefined {
  const credential = apply(s);
  if (!credential || !s.hosts?.length) return undefined;
  return {
    id: s.id,
    name: s.name,
    tokenUrl: s.docs ?? s.website ?? "",
    hosts: Object.fromEntries(s.hosts.map((h) => [h, credential])),
    env: [envName(s.id)],
  };
}

const curatedIds = new Set(CURATED.map((s) => s.id));
export const SERVICES: readonly Service[] = [...CURATED, ...CATALOG.filter((s) => !curatedIds.has(s.id)).flatMap((s) => fromCatalog(s) ?? [])];
const byId = new Map(SERVICES.map((s) => [s.id, s]));

export function service(id: string): Service {
  const s = byId.get(id);
  if (s) return s;
  const known = CATALOG.find((c) => c.id === id);
  if (known) throw new Error(`${known.name} is in the catalog, but the proxy doesn't know ${known.hosts?.length ? "how it takes its key" : "which hosts its API is on"} yet`);
  throw new Error(`Unknown service "${id}". See: sikrets proxy ls`);
}

/** Headers an agent might use to send its own credentials; the proxy always replaces them. */
export const AUTH_HEADERS = ["authorization", "x-api-key", "proxy-authorization"] as const;
