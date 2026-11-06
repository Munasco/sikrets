import { createHash } from "node:crypto";
import { GITLEAKS_ALLOW, GITLEAKS_PATTERNS } from "./gitleaks.ts";
import { entropy, GENERIC_KEYWORDS, GENERIC_RE, isWordy, judge, type Confidence, type Judged } from "./generic.ts";
import { DB_URL, FAKE_MARKER } from "./constants.ts";

export { entropy, type Confidence };

// What a leaked credential looks like. Provider-issued keys have fixed prefixes and lengths, so
// these match with few false positives; the generic rule catches `api_key = "..."` style
// assignments (src/generic.ts decides which are secrets, and how sure it is). After ours come gitleaks' 200+ rules
// (src/gitleaks.ts, generated from its vendored config), each gated by its keywords so a message
// only runs the few that could match.

export interface Pattern {
  id: string;
  name: string;
  /** Sikrets catalog id, for rotation advice. */
  service?: string;
  re: RegExp;
  /** Capture group holding the secret (default: the first non-empty group, else the whole match). */
  group?: number;
  /** Lowercase strings; the pattern runs only if the text contains one of them. */
  keywords?: string[];
  /** The secret's Shannon entropy must be above this. */
  entropy?: number;
  /** Only for files whose path matches; never for chat text. */
  path?: RegExp;
  /** Matches that aren't secrets after all. */
  allow?: Allow[];
  /** Decides from the whole match whether it's a secret: the value, and how sure. */
  judge?: (m: RegExpMatchArray, text: string, file: string | undefined, redacting: boolean) => Judged | undefined;
}

/** A gitleaks allowlist: a match is dropped if any check hits (all of them, with `all`). */
export interface Allow {
  /** What `regexes` test: the secret, the whole match, or the line it's on. */
  target: "secret" | "match" | "line";
  regexes: RegExp[];
  /** Substrings of the secret, lowercase. */
  stopwords?: string[];
  paths?: RegExp[];
  all?: boolean;
}

const OWN: Pattern[] = [
  { id: "aws-access-key", name: "AWS access key ID", service: "aws", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, group: 1 },
  { id: "aws-secret-key", name: "AWS secret access key", service: "aws", re: /aws_?secret_?access_?key["'\s]*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
  { id: "github-token", name: "GitHub token", service: "github", re: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g, group: 1 },
  { id: "github-pat", name: "GitHub fine-grained token", service: "github", re: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/g, group: 1 },
  { id: "gitlab-token", name: "GitLab token", service: "gitlab", re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { id: "slack-token", name: "Slack token", service: "slack", re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { id: "slack-webhook", name: "Slack webhook URL", service: "slack", re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,})/g, group: 1 },
  { id: "stripe-key", name: "Stripe secret key", service: "stripe", re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g, group: 1 },
  { id: "stripe-webhook", name: "Stripe webhook signing secret", service: "stripe", re: /\b(whsec_[A-Za-z0-9+/=]{20,})/g, group: 1 },
  { id: "resend-key", name: "Resend API key", service: "resend", re: /\b(re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,})\b/g, group: 1 },
  { id: "anthropic-key", name: "Anthropic API key", service: "anthropic", re: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,})/g, group: 1 },
  { id: "openai-key", name: "OpenAI API key", service: "openai", re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})/g, group: 1 },
  { id: "openai-key-new", name: "OpenAI API key", service: "openai", re: /\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,})/g, group: 1 },
  { id: "google-api-key", name: "Google API key", service: "google", re: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  { id: "huggingface", name: "Hugging Face token", service: "huggingface", re: /\b(hf_[A-Za-z]{34,})\b/g, group: 1 },
  { id: "npm-token", name: "npm token", service: "npm", re: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { id: "sendgrid", name: "SendGrid API key", service: "sendgrid", re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, group: 1 },
  { id: "twilio-key", name: "Twilio API key", service: "twilio", re: /\b(SK[0-9a-f]{32})\b/g, group: 1 },
  { id: "mailgun", name: "Mailgun API key", service: "mailgun", re: /\b(key-[0-9a-f]{32})\b/g, group: 1 },
  { id: "digitalocean", name: "DigitalOcean token", service: "digitalocean", re: /\b(do[por]_v1_[a-f0-9]{64})\b/g, group: 1 },
  { id: "shopify", name: "Shopify access token", service: "shopify", re: /\b(shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32})\b/g, group: 1 },
  { id: "telegram-bot", name: "Telegram bot token", service: "telegram", re: /\b(\d{8,10}:AA[A-Za-z0-9_-]{33})\b/g, group: 1 },
  { id: "private-key", name: "Private key", re: /(-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----(?:\\[rn]|\s)+(?:[\w-]+: [^\n]*(?:\\[rn]|\s)+)*[A-Za-z0-9+/=]{20}(?:[\s\S]{0,8000}?-----END \2-----)?)/g, group: 1 },
  { id: "db-url", name: "Database URL with password", re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:([^@\s/]{6,})@[^\s"'`]+)/g, group: 1 },
  { id: "jwt", name: "JSON Web Token", re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, group: 1 },
  {
    id: "generic-secret",
    name: "Hard-coded secret",
    // The name may be prefixed (SUPABASE_KEY, DB_PASSWORD) and the value unquoted (.env files).
    re: GENERIC_RE,
    keywords: GENERIC_KEYWORDS,
    judge: (m, text, file, redacting) => judge(m, text, file, PLACEHOLDER, redacting),
  },
];

/** Ours, then gitleaks', then the generic rule last, so a key gets the most specific name that fits
 * (and the service to rotate it at). */
export const PATTERNS: Pattern[] = [...OWN.filter((p) => p.id !== "generic-secret"), ...GITLEAKS_PATTERNS, ...OWN.filter((p) => p.id === "generic-secret")];
const FROM_GITLEAKS = new Set(GITLEAKS_PATTERNS);

/** Every keyword, by its first two characters, so one pass over the text finds all that are in it.
 * Checking each of the ~300 keywords with includes() reads a 60 KB message 300 times. */
const KEYWORDS = new Map<number, string[]>();
for (const k of new Set(PATTERNS.flatMap((p) => p.keywords ?? []))) {
  const key = k.charCodeAt(0) * 65536 + k.charCodeAt(1);
  KEYWORDS.set(key, [...(KEYWORDS.get(key) ?? []), k]);
}

function keywordsIn(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    const ks = KEYWORDS.get(lower.charCodeAt(i) * 65536 + lower.charCodeAt(i + 1));
    if (ks) for (const k of ks) if (lower.startsWith(k, i)) found.add(k);
  }
  return found;
}

export interface Finding {
  type: string;
  name: string;
  service?: string;
  /** Generic findings only: how sure the rule is (provider rules match the key's own format). */
  confidence?: Confidence;
  /** Redacted: a short prefix, the last four characters and the SHA-256, never the value. */
  redacted: string;
  sha256: string;
  line: number;
  file?: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** prefix…last4 — enough to recognize a key in a dashboard, not enough to use it. */
export function redact(secret: string): string {
  if (secret.startsWith("-----BEGIN")) return `${secret.split("\n")[0]!.slice(0, 50)} (key body hidden)`;
  const prefix = /^([a-z]{2,6}[_-](?:[a-z]{2,6}[_-])?|AKIA|ASIA|AIza|SG\.|eyJ)/i.exec(secret)?.[1] ?? secret.slice(0, 2);
  return secret.length <= 12 ? `${prefix}…` : `${prefix}…${secret.slice(-4)}`;
}

export const PLACEHOLDER = /^(?:https?:\/\/|\.{0,2}\/|x{6,}$|\*{4,}|\.{3,}|<[^>]+>|\$\{?[A-Z_]+\}?|your[_-]|example|changeme|placeholder|dummy|test[_-]?(?:key|token)|process\.env|os\.environ|env\()/i;

/** The header line, then (after any `Proc-Type:` style headers) the base64 body. */
const PEM_BODY = /PRIVATE KEY(?: BLOCK)?-----(?:\\[rn]|\s)+(?:[\w-]+: [^\n]*(?:\\[rn]|\s)+)*[A-Za-z0-9+/=]{20}/;

/** A database URL's password that could be real: not a template, not the user's name or a
 * default, and not for a database on this machine or an example host. */
function realDbPassword(url: string, password: string): boolean {
  if (PLACEHOLDER.test(password) || DB_URL.template.test(password)) return false;
  const user = /\/\/([^:/@]+):/.exec(url)?.[1] ?? "";
  if (password === user || DB_URL.defaults.includes(password.toLowerCase())) return false;
  const host = /@([^/?\s"'`]+)/.exec(url)?.[1]?.toLowerCase().replace(/:\d+$/, "") ?? "";
  return !DB_URL.template.test(host) && !DB_URL.localHost.test(host);
}

/** Says it's an example, or its random part is words (`xoxb-test-token-123`, `sk_live_abcdefghijklmnop`):
 * a stand-in in docs and tests, not a key. */
function isFake(value: string): boolean {
  if (FAKE_MARKER.test(value)) return true;
  const chunks = value.split(/[-_.]/).filter(Boolean);
  const long = chunks.filter((c) => c.length >= 8);
  return long.length ? long.every(isWordy) : chunks.some((c) => c.length >= 4 && isWordy(c));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Every credential-looking value in the text, redacted. The same value is reported once per file. */
export function scan(text: string, file?: string): Finding[] {
  return extract(text, file).map((e) => e.finding);
}

/** Every match of every pattern that could apply: those with keywords run only when one is in the text. */
function* matches(text: string, file?: string, redacting = false) {
  const found = keywordsIn(text);
  for (const p of PATTERNS) {
    if (p.path && !(file && p.path.test(file))) continue;
    if (p.keywords && !p.keywords.some((k) => found.has(k))) continue;
    for (const m of text.matchAll(p.re)) {
      if (p.judge) {
        const j = p.judge(m, text, file, redacting);
        if (j) yield { p, m, value: j.value, confidence: j.confidence, detail: { name: j.name, quoted: j.quoted } };
        continue;
      }
      const value = p.group !== undefined ? (m[p.group] ?? m[0]) : (m.slice(1).find(Boolean) ?? m[0]);
      yield { p, m, value, confidence: undefined as Confidence | undefined, detail: undefined as Detail | undefined };
    }
  }
}

export function allowed(a: Allow, secret: string, m: RegExpMatchArray, text: string, file?: string): boolean {
  const at = m.index ?? 0;
  const target = a.target === "secret" ? secret : a.target === "match" ? m[0] : text.slice(text.lastIndexOf("\n", at - 1) + 1, (text.indexOf("\n", at + m[0].length) + 1 || text.length + 1) - 1);
  const hits: boolean[] = [];
  if (a.regexes.length) hits.push(a.regexes.some((r) => r.test(target)));
  if (a.stopwords?.length) hits.push(a.stopwords.some((w) => secret.toLowerCase().includes(w)));
  if (a.paths?.length) hits.push(Boolean(file) && a.paths.some((r) => r.test(file!)));
  return a.all ? hits.length > 0 && hits.every(Boolean) : hits.some(Boolean);
}

/** For generic findings: the name the value is assigned to, and whether it was quoted. */
export interface Detail {
  name: string;
  quoted: boolean;
}

export interface Extracted {
  value: string;
  finding: Finding;
  detail?: Detail;
}

/** Like scan, but with the raw values too; for the server only, so it can keep them from the model.
 * `redacting` (chat redaction) also takes values that look made up: hiding a fake costs nothing. */
export function extract(text: string, file?: string, opts: { redacting?: boolean } = {}): Extracted[] {
  const redacting = opts.redacting ?? false;
  const out: Extracted[] = [];
  const seen = new Set<string>();
  // Where accepted secrets sit, so a later rule doesn't report part of a key an earlier one found.
  const spans: [number, number][] = [];
  for (const { p, m, value, confidence, detail } of matches(text, file, redacting)) {
    // A PEM header with no key body after it is code that looks for one (gitleaks' rule spans to
    // the END line, wherever that is).
    if (p.id === "private-key" && !PEM_BODY.test(value)) continue;
    if (p.id === "db-url" && (redacting ? PLACEHOLDER.test(m[2] ?? "") : !realDbPassword(m[1]!, m[2] ?? ""))) continue;
    // Provider-shaped, but marked as a fake (AKIA…EXAMPLE, xoxb-test-token-123): a stand-in in a
    // repo's docs and tests. A key someone pasted to ask about is reported whatever it says.
    if (file && !redacting && !confidence && p.id !== "private-key" && p.id !== "db-url" && isFake(value)) continue;
    if (p.entropy && entropy(value) <= p.entropy) continue;
    if (p.allow?.some((a) => allowed(a, value, m, text, file))) continue;
    const start = (m.index ?? 0) + Math.max(0, m[0].indexOf(value));
    if (FROM_GITLEAKS.has(p) && allowed(GITLEAKS_ALLOW, value, m, text, file)) continue;
    if (spans.some(([s, e]) => s <= start && start + value.length <= e)) continue;
    const hash = sha256(value);
    if (seen.has(hash)) continue;
    seen.add(hash);
    spans.push([start, start + value.length]);
    const finding = { type: p.id, name: p.name, service: p.service, redacted: p.id === "db-url" ? value.replace(m[2]!, "****") : redact(value), sha256: hash, line: lineAt(text, m.index ?? 0), file, ...(confidence ? { confidence } : {}) };
    out.push(detail ? { value, finding, detail } : { value, finding });
  }
  return out.sort((a, b) => a.finding.line - b.finding.line);
}

/** Every token-like string, for comparing against known leaked hashes. */
export function candidates(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9_\-+/=.:]{16,512}/g)) {
    set.add(m[0]);
    // Also the pieces, so `KEY=value` and `"value",` still match.
    for (const part of m[0].split(/[=:]/)) if (part.length >= 16) set.add(part);
  }
  for (const { value } of matches(text, undefined, true)) set.add(value);
  return [...set];
}
