import { createHash } from "node:crypto";

// What a leaked credential looks like. Provider-issued keys have fixed prefixes and lengths, so
// these match with few false positives; the generic rule catches `api_key = "..."` style
// assignments and keeps only high-entropy values.

export interface Pattern {
  id: string;
  name: string;
  /** Sikrets catalog id, for rotation advice. */
  service?: string;
  re: RegExp;
  /** Capture group holding the secret (default: the whole match). */
  group?: number;
}

export const PATTERNS: Pattern[] = [
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
  { id: "private-key", name: "Private key", re: /(-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----(?:[\s\S]{0,8000}?-----END \2-----)?)/g, group: 1 },
  { id: "db-url", name: "Database URL with password", re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:([^@\s/]{6,})@[^\s"'`]+)/g, group: 1 },
  { id: "jwt", name: "JSON Web Token", re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, group: 1 },
  {
    id: "generic-secret",
    name: "Hard-coded secret",
    re: /\b(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|access[_-]?key|client[_-]?secret|auth)\w*["']?\s*[:=]\s*["'`]([^"'`\s]{16,200})["'`]/gi,
    group: 1,
  },
];

export interface Finding {
  type: string;
  name: string;
  service?: string;
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

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const PLACEHOLDER = /^(?:https?:\/\/|\.{0,2}\/|x{6,}$|\*{4,}|\.{3,}|<[^>]+>|\$\{?[A-Z_]+\}?|your[_-]|example|changeme|placeholder|dummy|test[_-]?(?:key|token)|process\.env|os\.environ|env\()/i;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Every credential-looking value in the text, redacted. The same value is reported once per file. */
export function scan(text: string, file?: string): Finding[] {
  return extract(text, file).map((e) => e.finding);
}

/** Like scan, but with the raw values too; for the server only, so it can keep them from the model. */
export function extract(text: string, file?: string): { value: string; finding: Finding }[] {
  const out: { value: string; finding: Finding }[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const value = m[p.group ?? 0] ?? m[0];
      if (p.id === "generic-secret" && (PLACEHOLDER.test(value) || entropy(value) < 3.5)) continue;
      if (p.id === "db-url" && PLACEHOLDER.test(m[2] ?? "")) continue;
      const hash = sha256(value);
      if (seen.has(hash)) continue;
      seen.add(hash);
      const finding = { type: p.id, name: p.name, service: p.service, redacted: p.id === "db-url" ? value.replace(m[2]!, "****") : redact(value), sha256: hash, line: lineAt(text, m.index ?? 0), file };
      out.push({ value, finding });
    }
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
  for (const p of PATTERNS) for (const m of text.matchAll(p.re)) set.add(m[p.group ?? 0] ?? m[0]);
  return [...set];
}
