import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { GITLEAKS_PATTERNS, GITLEAKS_ALLOW } from "../src/gitleaks.ts";
import { allowed, type Pattern } from "../src/patterns.ts";
import { rng, sample } from "./sample.ts";

// The labeled corpus for scripts/scan-eval.ts. Every secret-shaped value is made here at run time
// from a seeded generator; the fixture files in eval/negatives hold code and placeholders only.

export interface Case {
  /** What it exercises: a rule id, a layout, a fixture file. */
  id: string;
  text: string;
  file?: string;
}

export interface Labeled extends Case {
  label: "secret" | "placeholder" | "code";
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const B64 = `${ALNUM}+/`;

function maker(seed: number) {
  const random = rng(seed);
  return {
    random,
    value: (n: number, set = ALNUM) => Array.from({ length: n }, () => set[Math.floor(random() * set.length)]).join(""),
  };
}

/** Rules whose regexes span lines or need a realistic host or body: written out by hand below. */
const BY_HAND = ["kubernetes-secret-yaml", "db-url", "private-key"];

/** One sample per rule (two seeds), in the text the rule needs: its keyword, its file type. A
 * sample the rule's own allowlist or entropy floor would drop is skipped: it isn't a positive. */
export function ruleCases(patterns: Pattern[]): { cases: (Case & { rule: string })[]; unsampled: string[] } {
  const cases: (Case & { rule: string })[] = [];
  const unsampled: string[] = [];
  for (const p of patterns) {
    if (p.id === "generic-secret" || BY_HAND.includes(p.id)) continue;
    let made = 0;
    for (let s = 1; s <= 60 && made < 2; s++) {
      const random = rng(s * 7919 + p.id.length * 131);
      const text = sample(p.re.source, random);
      if (!new RegExp(p.re.source, p.re.flags).test(text)) continue;
      // The secret part must be random enough for the rule's own entropy floor.
      const m = new RegExp(p.re.source, p.re.flags).exec(text)!;
      const secret = p.group !== undefined ? m[p.group] : m.slice(1).find(Boolean);
      if (p.entropy && secret && entropyOf(secret) <= p.entropy) continue;
      const file = p.path ? sample(p.path.source, random) : undefined;
      const allowlists = [...(p.allow ?? []), ...(GITLEAKS_PATTERNS.includes(p) ? [GITLEAKS_ALLOW] : [])];
      if (secret && allowlists.some((a) => allowed(a, secret, m, text, file))) continue;
      const keyword = !p.keywords || p.keywords.some((k) => text.toLowerCase().includes(k));
      cases.push({ id: `${p.id}#${made + 1}`, rule: p.id, text: keyword ? text : `# ${p.keywords![0]}\n${text}`, ...(file ? { file } : {}) });
      made++;
    }
    if (!made) unsampled.push(p.id);
  }
  const { value } = maker(99);
  for (const [i, v] of [value(24, B64), value(32, B64)].entries()) {
    cases.push({ id: `kubernetes-secret-yaml#${i + 1}`, rule: "kubernetes-secret-yaml", text: `apiVersion: v1\nkind: Secret\nmetadata:\n  name: api\ndata:\n  password: ${btoa(v)}\n`, file: "k8s/secret.yaml" });
  }
  const urls = [
    (p: string) => `DATABASE_URL=postgres://app_user:${p}@db-1.prod.acme-corp.io:5432/app`,
    (p: string) => `MONGO_URI="mongodb+srv://svc:${p}@cluster0.ab12c.mongodb.net/app?retryWrites=true"`,
    (p: string) => `redis: { url: "redis://default:${p}@redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345" }`,
  ];
  const pem = (kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----\n${Array.from({ length: 6 }, () => value(64, B64)).join("\n")}\n-----END ${kind}PRIVATE KEY-----`;
  cases.push(
    { id: "private-key#1", rule: "private-key", text: pem(""), file: "certs/server.key" },
    { id: "private-key#2", rule: "private-key", text: `export const KEY = \`${pem("RSA ")}\`;`, file: "src/tls.ts" },
    { id: "private-key#3", rule: "private-key", text: JSON.stringify({ private_key: `${pem("")}\n` }), file: "service-account.json" },
  );
  for (const [i, url] of urls.entries()) cases.push({ id: `db-url#${i + 1}`, rule: "db-url", text: url(value(24)), file: i === 2 ? "src/cache.ts" : ".env" });
  return { cases, unsampled };
}

function entropyOf(s: string) {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** `name = value` secrets in the layouts people commit them in, with values of several shapes. */
export function layoutCases(): Case[] {
  const { value } = maker(4242);
  const shapes = [() => value(32), () => value(40, B64) + "=", () => value(64, HEX), () => `${value(10)}!${value(6)}#${value(6)}`];
  const layouts: [string, (v: string) => string][] = [
    [".env", (v) => `API_KEY=${v}`],
    [".env.production", (v) => `SUPABASE_SERVICE_ROLE_KEY="${v}"`],
    ["config/.env.local", (v) => `export DB_PASSWORD='${v}'`],
    ["deploy/env.sh", (v) => `export STRIPE_SECRET_KEY=${v}`],
    ["Dockerfile", (v) => `ENV SENTRY_AUTH_TOKEN=${v}`],
    ["docker-compose.yml", (v) => `services:\n  api:\n    environment:\n      - JWT_SECRET=${v}`],
    ["config/app.yaml", (v) => `database:\n  host: db.internal\n  password: ${v}\n`],
    ["config/app.yml", (v) => `auth:\n  client_secret: "${v}"\n`],
    ["config.toml", (v) => `[stripe]\nsecret_key = "${v}"\n`],
    ["settings.ini", (v) => `[smtp]\nsmtp_password = ${v}\n`],
    ["application.properties", (v) => `jwt.secret=${v}`],
    ["config/oauth.json", (v) => `{ "client_id": "web", "client_secret": "${v}" }`],
    ["terraform.tfvars", (v) => `datadog_api_key = "${v}"`],
    [".npmrc", (v) => `//registry.example.org/:_authToken=${v}`],
    ["src/main.rs", (v) => `const API_KEY: &str = "${v}";`],
    ["app/settings.py", (v) => `SECRET_KEY = '${v}'`],
    ["app/client.py", (v) => `client = Client(api_key="${v}")`],
    ["cmd/server/main.go", (v) => `apiKey := "${v}"`],
    ["src/Main.java", (v) => `private static final String CLIENT_SECRET = "${v}";`],
    ["src/Config.kt", (v) => `val apiToken = "${v}"`],
    ["Sources/App/Keys.swift", (v) => `let apiKey: String = "${v}"`],
    ["config/initializers/stripe.rb", (v) => `Stripe.api_key = '${v}'`],
    ["config/services.php", (v) => `'secret' => '${v}',`],
    ["src/stripe.ts", (v) => `export const stripeKey = "${v}";`],
    ["src/client.ts", (v) => `fetch(url, { headers: { Authorization: "Bearer ${v}" } });`],
    ["web/config.js", (v) => `module.exports = { sessionSecret: "${v}" };`],
  ];
  const out: Case[] = [];
  for (const [file, line] of layouts) for (const [i, shape] of shapes.entries()) out.push({ id: `layout:${file}#${i + 1}`, text: line(shape()), file });
  // Pasted in chat: no file.
  for (const [i, shape] of shapes.entries()) out.push({ id: `chat#${i + 1}`, text: `here's my config\nOPENAI_API_KEY=${shape()}\nthanks` });
  return out;
}

/** The fixture files: real-looking code and placeholders, none of it a secret. */
export function fixtureCases(dir = path.join(import.meta.dir, "negatives")): Case[] {
  const out: Case[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const file = path.relative(dir, p);
        out.push({ id: `fixture:${file}`, text: readFileSync(p, "utf8"), file });
      }
    }
  };
  walk(dir);
  return out;
}

/** Provider-shaped stand-ins in docs and tests, and code around real-looking names: not secrets. */
export function generatedNegatives(): Case[] {
  const { value } = maker(77);
  return [
    { id: "fake:aws-example", text: `{ accessKeyId: "${"AKIA" + "IOSFODNN7EXAMPLE"}", secretAccessKey: "test-secret-key" }`, file: "test/s3.test.ts" },
    { id: "fake:slack-words", text: `token: '${"xoxb-" + "json-token"}',\ntoken: '${"xoxp-" + "after-reauth"}',`, file: "test/unit/token.test.ts" },
    { id: "fake:stripe-words", text: `const key = "${"sk_" + "test_" + "your_stripe_secret_key_here"}";`, file: "docs/setup.md" },
    { id: "fake:github-example", text: `GITHUB_TOKEN=${"ghp_" + "EXAMPLE" + value(29)}`, file: "README.md" },
    { id: "fake:db-template", text: "url: `postgresql://${user}:${password}@${host}:5432/app`", file: "src/db.ts" },
    { id: "fake:db-local", text: `DATABASE_URL=postgres://app:${"dev-" + "password"}@localhost:5432/app`, file: "sample.env" },
    { id: "fake:pem-header-only", text: `if (pem.startsWith("-----BEGIN PRIVATE KEY-----")) return parsePkcs8(pem);`, file: "src/pem.ts" },
    { id: "code:hash-compare", text: `if (sha256(token) === "${value(64, HEX)}") return true;`, file: "src/check.ts" },
    { id: "code:words-password", text: `const password = "${"Correct-Horse-" + "Battery-Staple-42"}";`, file: "test/auth.test.ts" },
    { id: "code:storage-key", text: `const COMPOSER_DRAFTS_KEY = "app:composer-drafts:v${3}";`, file: "src/drafts.ts" },
  ];
}

/** Values the rules can't settle (low or medium confidence), labeled, for the model check. */
export function ambiguousCases(): Labeled[] {
  const { value } = maker(2026);
  const cases: Labeled[] = [];
  for (let i = 0; i < 3; i++) {
    const r = value(40);
    const hex = value(64, HEX);
    const b64 = btoa(`${value(8)}:${value(16)}`);
    cases.push(
      { id: `secret:vendor-token#${i}`, label: "secret", file: "src/vendor/client.ts", text: `export const vendor = new VendorClient({\n  baseUrl: "https://api.vendor-cloud.io/v2",\n  token: "${r}",\n  timeoutMs: 10_000,\n});` },
      { id: `secret:aes-key#${i}`, label: "secret", file: "src/crypto.ts", text: `const key = "${hex}";\nconst cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);\nconst sealed = Buffer.concat([cipher.update(body), cipher.final()]);` },
      { id: `secret:registry-auth#${i}`, label: "secret", file: "deploy/push.ts", text: `const dockerConfig = {\n  auths: { "registry.vendor.io": { auth: "${b64}" } },\n};\nawait writeFile(path.join(home, ".docker/config.json"), JSON.stringify(dockerConfig));` },
      { id: `secret:webhook-signing#${i}`, label: "secret", file: "src/webhooks.py", text: `def verify(request):\n    signing_token = "${value(32)}"\n    expected = hmac.new(signing_token.encode(), request.body, "sha256").hexdigest()\n    return hmac.compare_digest(expected, request.headers["X-Signature"])` },
      { id: `placeholder:mock-key#${i}`, label: "placeholder", file: "test/fixtures/mock-server.test.ts", text: `// A made-up key the mock server accepts; it was never issued by anyone.\nconst apiKey = "${value(32)}";\nnock("https://api.vendor-cloud.io").get("/v2/me").matchHeader("x-api-key", apiKey).reply(200, {});` },
      { id: `placeholder:example-token#${i}`, label: "placeholder", file: "docs/examples/quickstart.ts", text: `// Example only: replace with the token from your dashboard.\nconst client = new Client({\n  token: "${value(36)}",\n});` },
      { id: `placeholder:sample-password#${i}`, label: "placeholder", file: "config/sample.yaml", text: `# Sample settings for local development; change before deploying.\nadmin:\n  user: admin\n  password: ${["Change", "Me", "Before", "Deploy"].join("-")}-${i + 1}\n` },
      { id: `code:git-sha#${i}`, label: "code", file: "scripts/release.ts", text: `// The commit the release branch was cut from, used to name the build.\nconst releaseKey = "${value(40, HEX)}";\nconst tag = \`build-\${releaseKey.slice(0, 7)}\`;` },
      { id: `secret:basic-auth#${i}`, label: "secret", file: "scripts/sync-orders.ts", text: `const res = await fetch("https://erp.acme-corp.io/api/orders", {\n  headers: { authorization: "Basic ${btoa(`svc-sync:${value(20)}`)}" },\n});` },
      { id: `placeholder:doc-uuid#${i}`, label: "placeholder", file: "src/appcheck/debug-token.ts", text: `/**\n * Registers a debug token for local testing, e.g.\n *   token: "${crypto.randomUUID()}",\n * Generate your own in the console; this one is an illustration.\n */` },
      { id: `code:trace-id#${i}`, label: "code", file: "src/telemetry.ts", text: `// W3C trace context: a 16-byte trace id, hex, copied from the incoming request.\nconst traceToken = "${value(32, HEX)}";\nspan.setAttribute("trace_id", traceToken);` },
      { id: `code:fixture-digest#${i}`, label: "code", file: "src/integrity.ts", text: `// SHA-256 of the bundled font file; the loader refuses a file with a different digest.\nconst fontDigestToken = "${value(64, HEX)}";\nif (digest(font) !== fontDigestToken) throw new Error("font changed");` },
    );
  }
  return cases;
}
