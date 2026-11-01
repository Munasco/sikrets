import type { Agent, Approval, Grant, ImportPreview, KeyRow, Login, Recovery, Status } from "./api.ts";

// A made-up project for the browser preview (outside Tauri). Names and dates only: there are no
// values here, as there are none anywhere in the window.

const day = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
const later = (days: number) => new Date(Date.now() + days * day).toISOString();

const keys: KeyRow[] = [
  { key: "STRIPE_SECRET_KEY", resource: "payments", recipe: "stripe/restricted-key", createdAt: at(41), lastRotatedAt: at(12), lastUsed: at(0.02), apps: ["bun", "next"], agents: ["claude-code"], stale: false, scope: { provider: "stripe", overScoped: true, detail: "secret key with full account access; use a restricted key (rk_)" } },
  { key: "OPENAI_API_KEY", resource: "llm", recipe: "openai/project-key", createdAt: at(64), lastRotatedAt: at(3), lastUsed: at(0.2), apps: ["bun"], agents: ["claude-code", "reviewer"], stale: false, scope: null },
  { key: "CACHE_REDIS_REST_TOKEN", resource: "cache", recipe: "upstash/redis", createdAt: at(18), lastRotatedAt: null, lastUsed: at(1), apps: ["next"], agents: [], stale: false, scope: null },
  { key: "GITHUB_TOKEN", resource: "github-app", recipe: "github/app-token", createdAt: at(130), lastRotatedAt: null, lastUsed: at(44), apps: ["gh"], agents: [], stale: true, scope: { provider: "github", overScoped: true, detail: "broad scopes: repo, admin:org" } },
  { key: "RESEND_API_KEY", resource: "email", recipe: "resend/api-key", createdAt: at(9), lastRotatedAt: null, lastUsed: null, apps: [], agents: [], stale: false, scope: null },
  { key: "SENTRY_AUTH_TOKEN", resource: "", recipe: "import", createdAt: at(5), lastRotatedAt: null, lastUsed: at(2), apps: ["sentry-cli"], agents: [], stale: false, scope: null, source: "bitwarden", ref: "bw://9f1c…/password" },
  { key: "DATADOG_API_KEY", resource: "", recipe: "import", createdAt: at(5), lastRotatedAt: null, lastUsed: null, apps: [], agents: [], stale: false, scope: null, source: ".env file" },
];

const agents: Agent[] = [
  { name: "claude-code", scope: ["llm", "payments"], createdAt: at(20), status: "active" },
  { name: "reviewer", scope: ["llm"], createdAt: at(6), expiresAt: later(1), status: "active" },
  { name: "ci-bot", scope: ["cache", "email"], createdAt: at(40), expiresAt: later(23), status: "active" },
  { name: "old-scraper", scope: ["github-app"], createdAt: at(90), revokedAt: at(12), status: "revoked" },
];

const approvals: Approval[] = [
  { id: "apr_4c1e9a20", resource: "payments", reason: "exposed", status: "pending", createdAt: at(0.03), expiresAt: later(0.97), message: "We think this key may be exposed" },
  { id: "apr_b7d20f13", resource: "github-app", reason: "expired", status: "pending", createdAt: at(0.4), expiresAt: later(0.6), message: "This key is past its rotation date" },
  { id: "apr_0e55a1c8", resource: "llm", reason: "requested", status: "pending", createdAt: at(0.1), expiresAt: later(0.9), message: "An agent asked to rotate this key" },
];

const logins: Login[] = [
  { name: "github", origin: "https://github.com", totp: true, addedAt: at(14) },
  { name: "stripe", origin: "https://dashboard.stripe.com", totp: true, addedAt: at(9) },
  { name: "vercel", origin: "https://vercel.com", totp: false, addedAt: at(2) },
];

const grants: Grant[] = [
  { login: "github", agent: "claude-code", grantedAt: at(10) },
  { login: "vercel", agent: "claude-code", grantedAt: at(1) },
  { login: "stripe", agent: "reviewer", grantedAt: at(3) },
];

const recovery: Recovery = { setUp: true, createdAt: at(21), split: false, matchesThisDevice: true, file: "~/.sikrets/recovery.json" };

const status: Status = {
  project: "shop",
  vault: "keychain",
  resources: ["payments", "llm", "cache", "github-app", "email"].map((name) => ({ name })),
};

const preview: ImportPreview = { dryRun: true, source: "~/Downloads/Passwords.csv", format: "Chrome passwords CSV", keys: ["LINEAR_API_KEY", "POSTHOG_KEY", "SUPABASE_SERVICE_ROLE", "VERCEL_TOKEN", "DATADOG_API_KEY"], replaced: ["DATADOG_API_KEY"] };

export async function demo(args: string[]): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  const [cmd, sub] = args;
  switch (cmd) {
    case "inventory":
      return { keys };
    case "status":
      return status;
    case "agent":
      return sub === "list" || !sub ? agents : {};
    case "approvals":
      return sub === "list" || !sub ? approvals : { ...approvals[0], status: "rotated" };
    case "logins":
      return sub === "grants" ? grants : sub === "ls" || !sub ? logins : {};
    case "recovery":
      return recovery;
    case "import":
      return preview;
    case "link":
      return keys.filter((k) => k.ref).map(({ key, ref }) => ({ key, ref }));
    case "unlock":
      return { manager: "bitwarden", account: "me@acme.dev", unlocked: true };
    default:
      return {};
  }
}
