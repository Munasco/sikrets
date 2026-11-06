import { $ } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ambiguousCases, fixtureCases, generatedNegatives, layoutCases, ruleCases, type Case } from "../eval/cases.ts";
import type { Extracted } from "../src/patterns.ts";

// Measures the scanner on a labeled corpus: synthetic true positives for every rule and the common
// .env/config layouts, and negatives (code that names keys and tokens, placeholders, fakes).
// Precision and recall, for this tree and, with --rev, for another commit's scanner on the same cases.
//
//   bun scripts/scan-eval.ts [--rev <git ref>] [--real <dir>,<dir>] [--out <file>] [--review] [--models <id>,<id>]
//
// --real scans local repos' tracked files (read-only) and counts what each scanner reports; --out
// writes those findings with the value masked, for labeling by hand. --review asks the model about
// the ambiguous cases (needs the agent's model key in the environment) and reports its accuracy and
// latency. Nothing here prints a value.

const { values: args } = parseArgs({
  options: { rev: { type: "string" }, real: { type: "string" }, out: { type: "string" }, review: { type: "boolean" }, models: { type: "string" } },
});

type Extract = (text: string, file?: string) => Extracted[];
const APP = path.join(import.meta.dir, "..");

/** The scanner as it was at a commit: its sources copied to a temporary tree and imported. */
async function scannerAt(rev: string): Promise<Extract> {
  const dir = mkdtempSync(path.join(tmpdir(), "scan-eval-"));
  const root = (await $`git -C ${APP} rev-parse --show-prefix`.text()).trim();
  for (const file of ["src/patterns.ts", "src/gitleaks.ts", "src/generic.ts", "src/constants.ts", "data/services.json"]) {
    const res = await $`git -C ${APP} show ${rev}:${root}${file}`.quiet().nothrow();
    if (res.exitCode) continue;
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), res.stdout);
  }
  return (await import(path.join(dir, "src/patterns.ts"))).extract;
}

const current: Extract = (await import("../src/patterns.ts")).extract;
const { PATTERNS } = await import("../src/patterns.ts");
const scanners: [string, Extract][] = [...(args.rev ? [[`${args.rev}`, await scannerAt(args.rev)] as [string, Extract]] : []), ["this tree", current]];

const rules = ruleCases(PATTERNS);
const positives: (Case & { rule?: string })[] = [...rules.cases, ...layoutCases()];
const negatives: Case[] = [...fixtureCases(), ...generatedNegatives()];
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");

console.log(`Corpus: ${positives.length} true-positive cases (${rules.cases.length} for ${new Set(rules.cases.map((c) => c.rule)).size} rules, ${positives.length - rules.cases.length} .env/config/code layouts), ${negatives.length} negative files/snippets (${negatives.reduce((n, c) => n + c.text.split("\n").length, 0)} lines).`);
if (rules.unsampled.length) console.log(`Rules with no sample: ${rules.unsampled.join(", ")}`);

for (const [label, extract] of scanners) {
  const missed = positives.filter((c) => !extract(c.text, c.file).length);
  const wrongRule = rules.cases.filter((c) => {
    const f = extract(c.text, c.file);
    return f.length && !f.some((x) => x.finding.type === c.rule);
  });
  const fps = negatives.flatMap((c) => extract(c.text, c.file).map((x) => ({ id: c.id, type: x.finding.type, line: x.finding.line, confidence: x.finding.confidence })));
  const tp = positives.length - missed.length;
  console.log(`\n${label}`);
  console.log(`  recall    ${pct(tp, positives.length)} (${tp}/${positives.length})${missed.length ? `; missed: ${missed.map((c) => c.id).slice(0, 12).join(", ")}${missed.length > 12 ? ", …" : ""}` : ""}`);
  console.log(`  precision ${pct(tp, tp + fps.length)} (${fps.length} false positives on negatives)`);
  if (wrongRule.length) console.log(`  found under another rule's name: ${wrongRule.length} (${wrongRule.map((c) => c.rule).slice(0, 8).join(", ")}${wrongRule.length > 8 ? ", …" : ""})`);
  for (const f of fps.slice(0, 15)) console.log(`    FP ${f.id}:${f.line} ${f.type}${f.confidence ? ` (${f.confidence})` : ""}`);
}

// --- local repos --------------------------------------------------------------------------------

if (args.real) {
  const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.next|\.git|target|__pycache__|\.venv)\/|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|wasm|lock|min\.js|map|svg|jar|bin|exe|dll|so|dylib)$/i;
  const files: { repo: string; file: string; text: string }[] = [];
  for (const dir of args.real.split(",")) {
    for (const file of (await $`git -C ${dir} ls-files`.quiet().text()).split("\n").filter(Boolean)) {
      // .env files in a working tree may hold the owner's real keys: never read them here.
      if (SKIP.test(`/${file}`) || /(^|\/)\.env/.test(file)) continue;
      const f = Bun.file(path.join(dir, file));
      if (!(await f.exists()) || f.size > 1_000_000) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.subarray(0, 8000).includes(0)) continue;
      files.push({ repo: path.basename(dir), file, text: new TextDecoder().decode(bytes) });
    }
  }
  console.log(`\nLocal repos: ${files.length} tracked text files in ${args.real.split(",").length} repos`);
  const listing: string[] = [];
  for (const [label, extract] of scanners) {
    const byType = new Map<string, number>();
    for (const { repo, file, text } of files) {
      for (const { value, finding } of extract(text, file)) {
        const key = finding.type === "generic-secret" ? `generic-secret (${finding.confidence ?? "no confidence"})` : finding.type;
        byType.set(key, (byType.get(key) ?? 0) + 1);
        if (label === "this tree") {
          const line = (text.split("\n")[finding.line - 1] ?? "").split(value).join("‹VALUE›").trim().slice(0, 160);
          const shape = value.replace(/[a-z]+/g, "a").replace(/[A-Z]+/g, "A").replace(/\d+/g, "0").slice(0, 40);
          listing.push(`${repo}/${file}:${finding.line}\t${finding.type}\t${finding.confidence ?? ""}\t${shape}\t${line}`);
        }
      }
    }
    const total = [...byType.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${label}: ${total} findings — ${[...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (args.out) {
    writeFileSync(args.out, `${listing.join("\n")}\n`);
    console.log(`  findings (values masked) written to ${args.out}`);
  }
}

// --- the model check ----------------------------------------------------------------------------

if (args.review) {
  const { describe, review } = await import("../src/review.ts");
  const ambiguous = ambiguousCases();
  const items = [];
  const labels = new Map<string, string>();
  let settled = 0;
  for (const c of ambiguous) {
    const generic = current(c.text, c.file).filter((x) => x.finding.confidence && x.finding.confidence !== "high");
    if (!generic.length) {
      settled++;
      continue;
    }
    const { value, finding, detail } = generic[0]!;
    items.push(describe(c.id, c.text, value, finding, detail));
    labels.set(c.id, c.label);
  }
  console.log(`\nModel check: ${items.length} ambiguous cases (low/medium confidence)${settled ? `; ${settled} more were settled by the rules alone` : ""}`);
  for (const model of (args.models ?? (await import("../src/constants.ts")).REVIEW.model).split(",")) {
    const r = await review(items, { model });
    if (r.skipped) {
      console.log(`  ${model}: skipped (${r.skipped})`);
      continue;
    }
    let exact = 0;
    let binary = 0;
    const wrong: string[] = [];
    for (const [id, label] of labels) {
      const v = r.reviews.get(id)?.verdict;
      if (v === label) exact++;
      if (v && (v === "secret") === (label === "secret")) binary++;
      else wrong.push(`${id} → ${v ?? "no answer"}`);
    }
    const ms = r.latencies.sort((a, b) => a - b);
    console.log(`  ${model}: ${r.reviews.size}/${items.length} answered, ${r.failed} failed batches; secret-or-not ${pct(binary, labels.size)}, exact ${pct(exact, labels.size)}; per batch of ≤${(await import("../src/constants.ts")).REVIEW.batch}: ${ms.join("/")} ms`);
    for (const w of wrong) console.log(`    wrong: ${w}`);
  }
}
