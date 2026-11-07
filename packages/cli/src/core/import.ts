import { Secret } from "./secret.ts";

// Parsers for the files people export from password managers and browsers, plus .env files. Each
// turns a file into vault entries named in the env var style Sikrets uses (GITHUB_COM_PASSWORD).
// Values are wrapped in Secret the moment they're read, so a summary or error can't show them.

export type ImportFormat = "dotenv" | "apple" | "chrome" | "firefox" | "1password-csv" | "bitwarden-csv" | "bitwarden-json" | "1pux";

export const FORMAT_NAMES: Record<ImportFormat, string> = {
  dotenv: ".env file",
  apple: "Apple Passwords CSV",
  chrome: "Chrome CSV",
  firefox: "Firefox CSV",
  "1password-csv": "1Password CSV",
  "bitwarden-csv": "Bitwarden CSV",
  "bitwarden-json": "Bitwarden JSON",
  "1pux": "1Password export (.1pux)",
};

export interface ImportEntry {
  key: string;
  value: Secret;
  /** Item title or env key it came from (a name, never a value). */
  item: string;
  /** Password manager item it mirrors, when imported straight from a vault. */
  ref?: string;
}

// ── Naming ────────────────────────────────────────────────────────────────

/** "github.com" + "password" → GITHUB_COM_PASSWORD; always a valid vault key. */
export function keyName(...parts: string[]): string {
  const key = parts
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return /^[A-Z]/.test(key) ? key : `ITEM_${key}`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Collects entries, skipping empty values and suffixing duplicate names (_2, _3…). */
class Collector {
  readonly entries: ImportEntry[] = [];
  readonly #seen = new Map<string, number>();
  add(item: string, key: string, value: string | Secret | null | undefined, ref?: string) {
    if (!value) return;
    const n = (this.#seen.get(key) ?? 0) + 1;
    this.#seen.set(key, n);
    this.entries.push({ key: n === 1 ? key : `${key}_${n}`, value: typeof value === "string" ? Secret.of(value) : value, item, ...(ref ? { ref } : {}) });
  }
  login(title: string, fields: { username?: string | null; password?: string | null; otp?: string | null }) {
    const name = title.trim() || "login";
    this.add(name, keyName(name, "username"), fields.username);
    this.add(name, keyName(name, "password"), fields.password);
    this.add(name, keyName(name, "otp"), fields.otp);
  }
}

// ── CSV ───────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim()));
}

const headerOf = (text: string) => (parseCsv(text.split(/\r?\n/, 1)[0] ?? "")[0] ?? []).map((h) => h.trim().toLowerCase());

function csvFormat(header: string[]): ImportFormat | undefined {
  const has = (...cols: string[]) => cols.every((c) => header.includes(c));
  if (has("login_password", "name")) return "bitwarden-csv";
  if (has("title", "url", "username", "password", "otpauth", "notes") && header.length === 6) return "apple";
  if (has("title", "password")) return "1password-csv";
  if (has("url", "username", "password", "httprealm")) return "firefox";
  if (has("name", "url", "username", "password")) return "chrome";
  return undefined;
}

function csvRecords(text: string): Record<string, string>[] {
  const [head, ...rows] = parseCsv(text);
  const cols = (head ?? []).map((h) => h.trim().toLowerCase());
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
}

/** Apple Passwords, Chrome, Firefox and 1Password CSVs: one login per row, columns named differently. */
function parseLoginCsv(text: string): ImportEntry[] {
  const out = new Collector();
  for (const r of csvRecords(text)) {
    const url = r.url ?? r.website ?? "";
    out.login(r.title || r.name || hostOf(url), { username: r.username, password: r.password, otp: r.otpauth || r["one-time password"] || r.otp });
  }
  return out.entries;
}

/** Bitwarden CSV. Custom fields arrive as "name: value" lines in one column. */
function parseBitwardenCsv(text: string): ImportEntry[] {
  const out = new Collector();
  for (const r of csvRecords(text)) {
    const title = r.name || hostOf(r.login_uri ?? "");
    out.login(title, { username: r.login_username, password: r.login_password, otp: r.login_totp });
    for (const line of (r.fields ?? "").split(/\r?\n/)) {
      const i = line.indexOf(": ");
      if (i > 0) out.add(title, keyName(title, line.slice(0, i)), line.slice(i + 2));
    }
  }
  return out.entries;
}

// ── JSON ──────────────────────────────────────────────────────────────────

interface BitwardenItem {
  name: string;
  login?: { username?: string | null; password?: string | null; totp?: string | null } | null;
  fields?: { name: string; value: string | null; type: number }[] | null;
}

/** Bitwarden's unencrypted JSON export, or a saved `bw list items`. Hidden custom fields come along. */
function parseBitwardenJson(text: string): ImportEntry[] {
  const data = JSON.parse(text) as { encrypted?: boolean; items?: BitwardenItem[] } | BitwardenItem[];
  if (!Array.isArray(data) && data.encrypted) throw new Error("This Bitwarden export is encrypted; export again as unencrypted JSON, or import straight from the vault: sikrets import bitwarden");
  const out = new Collector();
  for (const item of Array.isArray(data) ? data : (data.items ?? [])) {
    out.login(item.name, { username: item.login?.username, password: item.login?.password, otp: item.login?.totp });
    for (const f of item.fields ?? []) if (f.type === 1) out.add(item.name, keyName(item.name, f.name), f.value);
  }
  return out.entries;
}

interface OnePuxItem {
  overview?: { title?: string; url?: string };
  details?: {
    password?: string;
    loginFields?: { designation?: string; value?: string }[];
    sections?: { fields?: { title?: string; id?: string; value?: { concealed?: string; totp?: string } }[] }[];
  };
}

/** The export.data JSON inside a 1Password .1pux file. */
export function parseOnePux(text: string): ImportEntry[] {
  const data = JSON.parse(text) as { accounts?: { vaults?: { items?: OnePuxItem[] }[] }[] };
  const out = new Collector();
  for (const item of (data.accounts ?? []).flatMap((a) => a.vaults ?? []).flatMap((v) => v.items ?? [])) {
    const title = item.overview?.title || hostOf(item.overview?.url ?? "");
    const login = (d: string) => item.details?.loginFields?.find((f) => f.designation === d)?.value;
    out.login(title, { username: login("username"), password: login("password") ?? item.details?.password });
    for (const f of (item.details?.sections ?? []).flatMap((s) => s.fields ?? [])) {
      if (f.value?.concealed) out.add(title, keyName(title, f.title || f.id || "secret"), f.value.concealed);
      if (f.value?.totp) out.add(title, keyName(title, "otp"), f.value.totp);
    }
  }
  return out.entries;
}

/** Entries listed straight from a password manager (`bw list items`, `op item get`), each keeping its reference. */
export function fromManager(list: readonly { item: string; field: string; ref: string; value: Secret }[]): ImportEntry[] {
  const out = new Collector();
  for (const e of list) out.add(e.item, keyName(e.item, e.field), e.value, e.ref);
  return out.entries;
}

// ── .env ──────────────────────────────────────────────────────────────────

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** KEY=value lines: double quotes (with \n escapes, may span lines), single quotes, `export`, # comments. */
export function parseDotenv(text: string): ImportEntry[] {
  const out = new Collector();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ENV_LINE.exec(lines[i]!);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    let value: string;
    if (raw.startsWith('"')) {
      let body = raw.slice(1);
      while (!/(^|[^\\])"\s*(#.*)?$/.test(body) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      value = body.replace(/"\s*(#.*)?$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (raw.startsWith("'")) value = raw.slice(1).replace(/'\s*(#.*)?$/, "");
    else value = raw.replace(/\s+#.*$/, "").trim();
    out.add(key, keyName(key), value);
  }
  return out.entries;
}

// ── Detection ─────────────────────────────────────────────────────────────

/** Works out the format from the file name and contents. */
export function detectFormat(file: string, text: string): ImportFormat {
  if (file.toLowerCase().endsWith(".1pux")) return "1pux";
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const data = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
    if (Array.isArray(data) || "items" in data) return "bitwarden-json";
    if ("accounts" in data) return "1pux";
    throw new Error(`${file} is JSON, but not a Bitwarden or 1Password export`);
  }
  const csv = csvFormat(headerOf(trimmed));
  if (csv) return csv;
  if (trimmed.split(/\r?\n/).some((l) => ENV_LINE.test(l))) return "dotenv";
  throw new Error(`Can't tell what kind of export ${file} is. Pass --format (${Object.keys(FORMAT_NAMES).join(", ")})`);
}

/** Parses text in a known format. For 1pux, pass the export.data JSON from inside the zip. */
export function parseExport(format: ImportFormat, text: string): ImportEntry[] {
  switch (format) {
    case "dotenv":
      return parseDotenv(text);
    case "apple":
    case "chrome":
    case "firefox":
    case "1password-csv":
      return parseLoginCsv(text);
    case "bitwarden-csv":
      return parseBitwardenCsv(text);
    case "bitwarden-json":
      return parseBitwardenJson(text);
    case "1pux":
      return parseOnePux(text);
  }
}
