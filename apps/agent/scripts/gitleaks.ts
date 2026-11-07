import { readFileSync } from "node:fs";
import path from "node:path";
import services from "../data/services.json";
import { GITLEAKS } from "../src/constants.ts";

// Compiles gitleaks' default rules (vendor/gitleaks/gitleaks.toml, MIT) into src/gitleaks.ts, in
// our Pattern format: `bun run build:rules`. gitleaks is written in Go, and Go's regexp syntax
// differs from JavaScript's in a few places, so each regex is converted here and compiled once to
// check it. A rule whose regex (or allowlist) can't be converted is left out and listed with the
// reason; so are rules that only match file names, since chat text has none.

interface Rule {
  id: string;
  description?: string;
  regex?: string;
  path?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: AllowList[];
}

interface AllowList {
  condition?: "OR" | "AND";
  regexTarget?: "secret" | "match" | "line";
  regexes?: string[];
  stopwords?: string[];
  paths?: string[];
}

const ROOT = path.join(import.meta.dir, "..");

/** POSIX classes RE2 accepts inside brackets, e.g. `[[:alnum:]_]`. */
const POSIX: Record<string, string> = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
  space: "\\t\\n\\v\\f\\r ",
  punct: "!-\\/:-@\\[-`{-~",
};

/**
 * A Go (RE2) regex as a JavaScript one. What differs:
 * - A flag group mid-pattern, `a(?i)b`, applies to the rest of its group in Go; JS only has scoped
 *   modifiers, so it becomes `a(?i:b)`, closed and reopened around each `|` of that group. A leading
 *   one covers the whole pattern and becomes a regex flag.
 * - `(?P<name>…)` is a named group; names are unused (gitleaks numbers groups), so it becomes `(…)`.
 * - `\z` and `\A` are the text's end and start: `$` and `^` without the m flag.
 * - `[]…]` and `[^]…]` start with a literal `]`; in JS `[^]` matches anything, so it's escaped.
 * - POSIX classes like `[[:alnum:]]` are spelled out.
 * Anything else RE2 has and JS lacks throws, and the rule is skipped.
 */
export function convert(go: string): { source: string; flags: string } {
  let s = go;
  let flags = "";
  const lead = /^\(\?([is]+)\)/.exec(s);
  if (lead) {
    flags = lead[1]!;
    s = s.slice(lead[0].length);
  }
  let out = "";
  // Per open group: the modifier wrappers a mid-pattern flag opened in it.
  const mods: string[][] = [[]];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      const n = s[i + 1];
      if (n === undefined) throw new Error("trailing backslash");
      if (n === "z") out += "$";
      else if (n === "A") out += "^";
      else if ("QECpPx".includes(n) && (n !== "x" || s[i + 2] === "{")) throw new Error(`unsupported escape \\${n}`);
      else out += c + n;
      i++;
    } else if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (s[j] === "^") cls += s[j++];
      if (s[j] === "]") (cls += "\\]"), j++;
      for (; j < s.length && s[j] !== "]"; j++) {
        if (s[j] === "\\") {
          cls += s[j]! + s[++j]!;
        } else if (s[j] === "[" && s[j + 1] === ":") {
          const end = s.indexOf(":]", j);
          const name = s.slice(j + 2, end);
          if (end < 0 || !POSIX[name]) throw new Error(`unsupported class [:${name}:]`);
          cls += POSIX[name];
          j = end + 1;
        } else if (s[j] === "[") {
          cls += "\\[";
        } else {
          cls += s[j];
        }
      }
      if (j >= s.length) throw new Error("unclosed character class");
      out += cls + "]";
      i = j;
    } else if (c === "(") {
      const flag = /^\(\?([a-zA-Z-]+)\)/.exec(s.slice(i));
      const named = /^\(\?P?<[A-Za-z_]\w*>/.exec(s.slice(i));
      if (flag) {
        if (!/^-?[ism]+$/.test(flag[1]!)) throw new Error(`unsupported flags (?${flag[1]})`);
        out += `(?${flag[1]}:`;
        mods.at(-1)!.push(flag[1]!);
        i += flag[0].length - 1;
      } else if (named) {
        out += "(";
        mods.push([]);
        i += named[0].length - 1;
      } else {
        if (s[i + 1] === "?" && !/^\(\?(?::|-?[ism]+:)/.test(s.slice(i))) throw new Error(`unsupported group ${s.slice(i, i + 4)}`);
        out += c;
        mods.push([]);
      }
    } else if (c === "|") {
      const m = mods.at(-1)!;
      out += ")".repeat(m.length) + "|" + m.map((f) => `(?${f}:`).join("");
    } else if (c === ")") {
      if (mods.length < 2) throw new Error("unbalanced )");
      out += ")".repeat(mods.pop()!.length) + ")";
    } else {
      out += c;
    }
  }
  if (mods.length !== 1) throw new Error("unbalanced (");
  out += ")".repeat(mods[0]!.length);
  new RegExp(out, flags); // throws if JS can't compile it
  return { source: out, flags };
}

/**
 * Drops a lazy `[\w.-]{0,50}?` that opens a pattern (most of gitleaks' `name = value` rules start
 * with one, some with two nested). It only widens the match to the left, inside the same line, so
 * the secret and the line are unchanged; but in a backtracking engine every position retries it
 * 50 ways, and two nested ones cost 2,500 tries per position on a long word.
 */
export function trim(source: string): string {
  let prev;
  do {
    prev = source;
    source = source.replace(/^((?:\(\?-?[ism]*:)*)\[\\w\.-\]\{0,50\}\?/, "$1");
  } while (source !== prev);
  return source;
}

const lit = (v: unknown) => JSON.stringify(v);
const re = (go: string, extra = "") => {
  const { source: converted, flags } = convert(go);
  const source = trim(converted);
  return `re(${lit(source)}, ${lit(flags + extra)})`;
};

/** The Sikrets catalog id a rule belongs to: the longest catalog id its own id starts with. */
const CATALOG = new Set((services as { id: string }[]).map((s) => s.id));
function serviceOf(id: string): string | undefined {
  const parts = id.split("-");
  for (let n = parts.length; n > 0; n--) {
    const service = parts.slice(0, n).join("-");
    if (CATALOG.has(service) && !GITLEAKS.notServices.includes(service)) return service;
  }
}

const ACRONYMS: Record<string, string> = { api: "API", aws: "AWS", gcp: "GCP", id: "ID", jwt: "JWT", pat: "PAT", ssh: "SSH", url: "URL", sdk: "SDK", oauth: "OAuth", pypi: "PyPI", npm: "npm", gpg: "GPG", pgp: "PGP", jdbc: "JDBC" };

/** A short name from the rule id, like ours: "stripe-access-token" → "Stripe access token". */
function nameOf(id: string): string {
  const words = id.split("-").map((w) => ACRONYMS[w] ?? w);
  const first = words[0]!;
  words[0] = first === first.toLowerCase() ? first[0]!.toUpperCase() + first.slice(1) : first;
  return words.join(" ");
}

function allow(a: AllowList) {
  const regexes = (a.regexes ?? []).map((r) => re(r));
  const fields = [`target: ${lit(a.regexTarget ?? "secret")}`, `regexes: [${regexes.join(", ")}]`];
  const stopwords = (a.stopwords ?? []).map((w) => w.toLowerCase());
  if (stopwords.length) fields.push(`stopwords: ${lit(stopwords)}`);
  if (a.paths?.length) fields.push(`paths: [${a.paths.map((p) => re(p)).join(", ")}]`);
  if (a.condition === "AND") fields.push("all: true");
  return `{ ${fields.join(", ")} }`;
}

/** The generated module's source, and what was left out. */
export function build(toml = Bun.TOML.parse(readFileSync(path.join(ROOT, GITLEAKS.config), "utf8")) as { allowlist?: AllowList; rules: Rule[] }) {
  const lines: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const r of toml.rules) {
    if (GITLEAKS.replaced.includes(r.id)) {
      skipped.push({ id: r.id, reason: "replaced by our generic-secret rule" });
      continue;
    }
    if (GITLEAKS.slow.includes(r.id)) {
      skipped.push({ id: r.id, reason: "backtracks badly in JavaScript" });
      continue;
    }
    if (!r.regex) {
      skipped.push({ id: r.id, reason: "matches file names only" });
      continue;
    }
    try {
      const service = serviceOf(r.id);
      const fields = [`id: ${lit(r.id)}`, `name: ${lit(nameOf(r.id))}`];
      if (service) fields.push(`service: ${lit(service)}`);
      fields.push(`re: ${re(r.regex, "g")}`);
      if (r.secretGroup) fields.push(`group: ${r.secretGroup}`);
      if (r.keywords?.length) fields.push(`keywords: ${lit(r.keywords.map((k) => k.toLowerCase()))}`);
      if (r.entropy) fields.push(`entropy: ${r.entropy}`);
      if (r.path) fields.push(`path: ${re(r.path)}`);
      if (r.allowlists?.length) fields.push(`allow: [${r.allowlists.map((a) => allow(a)).join(", ")}]`);
      lines.push(`  { ${fields.join(", ")} },`);
    } catch (e) {
      skipped.push({ id: r.id, reason: `Go regex: ${(e as Error).message}` });
    }
  }
  const global = allow(toml.allowlist ?? {});
  const source = `// Generated by scripts/gitleaks.ts from ${GITLEAKS.config}: gitleaks ${GITLEAKS.version}'s default
// rules (${GITLEAKS.source}). Do not edit; run \`bun run build:rules\`.
//
// gitleaks is MIT licensed, Copyright (c) 2019 Zachary Rice; the full notice is in
// vendor/gitleaks/LICENSE.

import type { Allow, Pattern } from "./patterns.ts";

const re = (source: string, flags: string) => new RegExp(source, flags);

export const GITLEAKS_PATTERNS: Pattern[] = [
${lines.join("\n")}
];

/** gitleaks' global allowlist: applies to every rule above. */
export const GITLEAKS_ALLOW: Allow = ${global};

/** Rules left out, and why. */
export const GITLEAKS_SKIPPED: { id: string; reason: string }[] = ${JSON.stringify(skipped, null, 2)};
`;
  return { source, rules: toml.rules.length, kept: lines.length, skipped };
}

if (import.meta.main) {
  const { source, rules, kept, skipped } = build();
  await Bun.write(path.join(ROOT, GITLEAKS.out), source);
  console.log(`${GITLEAKS.out}: ${kept} of ${rules} gitleaks rules; ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
}
