import services from "../data/services.json";
import { candidates, scan, sha256, redact, type Finding } from "./patterns.ts";
import { LIMITS } from "./constants.ts";

// The agent's tools. They run on the server and never hand the model a raw secret: findings are
// redacted to prefix…last4 plus a SHA-256, which is enough to find the key in a dashboard and
// rotate it, and useless to anyone who reads the chat.

interface CatalogService {
  id: string;
  name: string;
  category?: string;
  auth?: string;
  header?: string;
  query?: string;
  docs?: string;
  website?: string;
  hosts?: string[];
}
const SERVICES = services as CatalogService[];

/** Where to revoke and reissue keys for the services people leak most. */
const ROTATE: Record<string, { url: string; env: string[]; note?: string }> = {
  github: { url: "https://github.com/settings/tokens", env: ["GITHUB_TOKEN", "GH_TOKEN"], note: "Also check Settings → Applications for OAuth apps using it." },
  stripe: { url: "https://dashboard.stripe.com/apikeys", env: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], note: "Roll the key in the dashboard; webhook secrets are rolled per endpoint under Developers → Webhooks." },
  openai: { url: "https://platform.openai.com/api-keys", env: ["OPENAI_API_KEY"] },
  anthropic: { url: "https://console.anthropic.com/settings/keys", env: ["ANTHROPIC_API_KEY"] },
  aws: { url: "https://console.aws.amazon.com/iam/home#/security_credentials", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], note: "Deactivate the access key first, check CloudTrail for its use, then delete it. Prefer IAM roles or SSO over long-lived keys." },
  resend: { url: "https://resend.com/api-keys", env: ["RESEND_API_KEY"] },
  slack: { url: "https://api.slack.com/apps", env: ["SLACK_BOT_TOKEN", "SLACK_WEBHOOK_URL"], note: "Reinstall the app to rotate bot tokens; regenerate webhook URLs under Incoming Webhooks." },
  google: { url: "https://console.cloud.google.com/apis/credentials", env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], note: "Restrict the new key to the APIs and referrers it needs." },
  gitlab: { url: "https://gitlab.com/-/user_settings/personal_access_tokens", env: ["GITLAB_TOKEN"] },
  huggingface: { url: "https://huggingface.co/settings/tokens", env: ["HF_TOKEN"] },
  npm: { url: "https://www.npmjs.com/settings/~/tokens", env: ["NPM_TOKEN"] },
  sendgrid: { url: "https://app.sendgrid.com/settings/api_keys", env: ["SENDGRID_API_KEY"] },
  twilio: { url: "https://console.twilio.com/us1/account/keys-credentials/api-keys", env: ["TWILIO_API_KEY", "TWILIO_API_SECRET"] },
  vercel: { url: "https://vercel.com/account/settings/tokens", env: ["VERCEL_TOKEN"] },
};

// --- scan_text --------------------------------------------------------------------------------

export function scanText(input: { text: string }) {
  const text = String(input.text ?? "").slice(0, LIMITS.textBytes);
  const findings = scan(text);
  return { findings, count: findings.length, scannedChars: text.length };
}

// --- scan_github_repo -------------------------------------------------------------------------

const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|\.next|\.git|target|__pycache__|\.venv)\//;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|wasm|lock|min\.js|map|svg|jar|bin|exe|dll|so|dylib)$/i;

interface TarEntry {
  path: string;
  data: Uint8Array;
}

/** Regular files from a tar archive (ustar and pax long names; enough for GitHub's tarballs). */
export function untar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  const dec = new TextDecoder();
  const str = (o: number, n: number) => dec.decode(buf.subarray(o, o + n)).replace(/\0.*$/s, "");
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const name = str(off, 100);
    if (!name) break;
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(buf[off + 156] ?? 48);
    const prefix = str(off + 345, 155);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === "x") {
      const path = /\d+ path=([^\n]+)\n/.exec(dec.decode(body))?.[1];
      if (path) longName = path;
    } else if (type === "L") {
      longName = dec.decode(body).replace(/\0.*$/s, "");
    } else {
      if (type === "0" || type === "\0") out.push({ path: longName ?? (prefix ? `${prefix}/${name}` : name), data: body });
      longName = undefined;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export async function scanGithubRepo(input: { repo: string; ref?: string }) {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(input.repo ?? "").trim());
  if (!m) return { error: "Give the repo as owner/name or a github.com URL." };
  const [, owner, name] = m;
  const ref = input.ref?.trim() || "HEAD";
  const res = await fetch(`https://codeload.github.com/${owner}/${name}/tar.gz/${encodeURIComponent(ref)}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return { error: `${owner}/${name}@${ref} wasn't found, or it's private (only public repos can be scanned here).` };
  if (!res.ok) return { error: `GitHub returned ${res.status}.` };
  const gz = new Uint8Array(await res.arrayBuffer());
  if (gz.length > LIMITS.tarballBytes) return { error: `The repo tarball is over ${LIMITS.tarballBytes / 1e6} MB; scan it locally with the Sikrets CLI instead.` };
  const entries = untar(Bun.gunzipSync(gz));
  const findings: Finding[] = [];
  let files = 0;
  for (const e of entries) {
    const path = e.path.replace(/^[^/]+\//, ""); // drop the "<repo>-<sha>/" root
    if (SKIP_DIR.test(`/${path}`) || SKIP_EXT.test(path) || e.data.length > LIMITS.fileBytes) continue;
    if (e.data.subarray(0, 8000).includes(0)) continue; // binary
    files++;
    for (const f of scan(new TextDecoder().decode(e.data), path)) {
      if (findings.length < LIMITS.findings) findings.push(f);
    }
  }
  return {
    repo: `${owner}/${name}`,
    ref,
    filesScanned: files,
    count: findings.length,
    truncated: findings.length >= LIMITS.findings,
    findings: findings.map((f) => ({ ...f, url: `https://github.com/${owner}/${name}/blob/${ref}/${f.file}#L${f.line}` })),
    note: "Only the latest commit was scanned. A key removed in a later commit is still in git history and must be rotated.",
  };
}

// --- check_leak_hashes ------------------------------------------------------------------------

export async function checkLeakHashes(input: { hashes: string[]; text?: string; repo?: string }) {
  const targets = new Set((input.hashes ?? []).map((h) => String(h).trim().toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)));
  if (!targets.size) return { error: "Give one or more SHA-256 hashes (64 hex characters)." };
  const sources: { file?: string; text: string }[] = [];
  if (input.text) sources.push({ text: String(input.text).slice(0, LIMITS.textBytes) });
  if (input.repo) {
    const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.repo.trim());
    if (!m) return { error: "Give the repo as owner/name." };
    const res = await fetch(`https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/HEAD`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { error: `Couldn't download ${m[1]}/${m[2]} (${res.status}).` };
    const gz = new Uint8Array(await res.arrayBuffer());
    if (gz.length > LIMITS.tarballBytes) return { error: "That repo is too large to check here." };
    for (const e of untar(Bun.gunzipSync(gz))) {
      if (e.data.length > LIMITS.fileBytes || e.data.subarray(0, 8000).includes(0)) continue;
      sources.push({ file: e.path.replace(/^[^/]+\//, ""), text: new TextDecoder().decode(e.data) });
    }
  }
  if (!sources.length) return { error: "Give text or a repo to check against the hashes." };
  const matches: { sha256: string; redacted: string; file?: string }[] = [];
  let checked = 0;
  for (const s of sources) {
    for (const c of candidates(s.text)) {
      checked++;
      const h = sha256(c);
      if (targets.has(h) && !matches.some((x) => x.sha256 === h && x.file === s.file)) matches.push({ sha256: h, redacted: redact(c), file: s.file });
    }
  }
  return { hashes: targets.size, candidatesChecked: checked, matched: [...new Set(matches.map((m) => m.sha256))].length, matches };
}

// --- how_to_rotate ----------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function howToRotate(input: { service: string }) {
  const q = norm(String(input.service ?? ""));
  if (!q) return { error: "Name a service, e.g. stripe or github." };
  const exact = SERVICES.find((s) => norm(s.id) === q || norm(s.name) === q);
  const matches = exact ? [exact] : SERVICES.filter((s) => norm(s.id).includes(q) || norm(s.name).includes(q)).slice(0, 5);
  if (!matches.length) return { error: `"${input.service}" isn't in the Sikrets catalog (${SERVICES.length} services).` };
  return {
    results: matches.map((s) => {
      const known = ROTATE[s.id];
      const env = known?.env ?? [`${s.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
      return {
        id: s.id,
        name: s.name,
        category: s.category,
        rotateAt: known?.url ?? s.docs ?? s.website,
        note: known?.note,
        envVars: env,
        apiHosts: s.hosts ?? [],
        auth: s.auth,
        sikrets: s.hosts?.length
          ? [`sikrets proxy add ${s.id}`, `sikrets session run ${s.id} --for 1h -- <agent>`]
          : [`sikrets add ${s.id}`],
      };
    }),
  };
}

// --- osv_lookup -------------------------------------------------------------------------------

const ECOSYSTEMS: Record<string, string> = { npm: "npm", pypi: "PyPI", pip: "PyPI", python: "PyPI", go: "Go", golang: "Go", cargo: "crates.io", crates: "crates.io", rust: "crates.io", maven: "Maven", rubygems: "RubyGems", gem: "RubyGems", nuget: "NuGet", packagist: "Packagist", composer: "Packagist" };

export async function osvLookup(input: { name: string; version?: string; ecosystem?: string }) {
  const ecosystem = ECOSYSTEMS[String(input.ecosystem ?? "npm").toLowerCase()] ?? input.ecosystem ?? "npm";
  const body = { package: { name: input.name, ecosystem }, ...(input.version ? { version: input.version } : {}) };
  const res = await fetch("https://api.osv.dev/v1/query", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { error: `OSV returned ${res.status}.` };
  const data = (await res.json()) as { vulns?: Array<{ id: string; summary?: string; aliases?: string[]; database_specific?: { severity?: string }; affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }> }> };
  const vulns = (data.vulns ?? []).map((v) => ({
    id: v.id,
    aliases: v.aliases?.slice(0, 3),
    summary: v.summary,
    severity: v.database_specific?.severity,
    fixedIn: [...new Set(v.affected?.flatMap((a) => a.ranges?.flatMap((r) => r.events?.map((e) => e.fixed).filter(Boolean) ?? []) ?? []) ?? [])].slice(0, 4),
  }));
  return { package: `${input.name}${input.version ? `@${input.version}` : ""}`, ecosystem, count: vulns.length, vulns: vulns.slice(0, 15), source: "https://osv.dev" };
}

// --- registry ---------------------------------------------------------------------------------

export const TOOLS = {
  scan_text: {
    description: "Find leaked credentials (API keys, tokens, private keys, database URLs) in text or code the user pasted. Returns redacted findings with line numbers; never the values.",
    schema: { type: "object", properties: { text: { type: "string", description: "The text or code to scan." } }, required: ["text"] },
    run: scanText,
  },
  scan_github_repo: {
    description: "Download a public GitHub repo's latest commit and scan every text file for leaked credentials. Returns redacted findings with file, line and a link.",
    schema: { type: "object", properties: { repo: { type: "string", description: "owner/name or a github.com URL" }, ref: { type: "string", description: "Branch, tag or commit (default: the default branch)." } }, required: ["repo"] },
    run: scanGithubRepo,
  },
  check_leak_hashes: {
    description: "Check whether specific leaked keys, given only as SHA-256 hashes (e.g. from a leak notice), appear in pasted text or a public GitHub repo. Compares hashes; the keys themselves are never needed.",
    schema: { type: "object", properties: { hashes: { type: "array", items: { type: "string" }, description: "SHA-256 hex hashes of the leaked keys." }, text: { type: "string" }, repo: { type: "string", description: "owner/name of a public repo" } }, required: ["hashes"] },
    run: checkLeakHashes,
  },
  how_to_rotate: {
    description: "Look up a service in the Sikrets catalog (3,000+ services): where to revoke and reissue its key, the env var names, its API hosts, and the Sikrets commands to keep the new key out of agents' hands.",
    schema: { type: "object", properties: { service: { type: "string", description: "Service name or id, e.g. stripe" } }, required: ["service"] },
    run: howToRotate,
  },
  osv_lookup: {
    description: "Look up known vulnerabilities for a package (and optionally a version) in the OSV database.",
    schema: { type: "object", properties: { name: { type: "string" }, version: { type: "string" }, ecosystem: { type: "string", description: "npm, PyPI, Go, crates.io, Maven, RubyGems, NuGet, Packagist" } }, required: ["name"] },
    run: osvLookup,
  },
} as const;

export type ToolName = keyof typeof TOOLS;

export async function runTool(name: string, input: unknown): Promise<unknown> {
  const tool = TOOLS[name as ToolName];
  if (!tool) return { error: `Unknown tool ${name}` };
  try {
    return await (tool.run as (i: unknown) => unknown)(input ?? {});
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
