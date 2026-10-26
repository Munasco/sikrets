// Checks every provider in src/catalog/saas.json against the live web and records what changed in
// src/catalog/watch.json, so the catalog stays true without anyone re-reading 150 docs sites:
//   - docs pages that moved (redirects) are updated in saas.json automatically,
//   - pages that are gone, pages whose text changed, and Terraform providers that disappeared are
//     listed in a report for a person to review; facts like apiKeyCreation are never auto-edited.
// Run weekly by .github/workflows/catalog-watch.yml, which opens a PR with the report:
//   bun scripts/watch-catalog.ts [--report report.md]
import { createHash } from "node:crypto";
import path from "node:path";
import { USER_AGENT } from "../src/constants.ts";

interface SaasEntry {
  id: string;
  name: string;
  docs: string;
  terraform: string | null;
  [k: string]: unknown;
}

type Status = "ok" | "gone" | "error";

interface Watch {
  url: string;
  status: Status;
  /** Hash of the page's visible text, without numbers and ids that change on every build. */
  hash?: string;
  terraform?: "ok" | "gone";
  checkedAt: string;
  changedAt?: string;
}

// Never contacted from automation (the account owner asked for that).
const SKIP = new Set(["openai"]);
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;

const dir = path.join(import.meta.dir, "../src/catalog");
const saasFile = path.join(dir, "saas.json");
const watchFile = path.join(dir, "watch.json");
const reportArg = Bun.argv.indexOf("--report");
const reportFile = reportArg > 0 ? Bun.argv[reportArg + 1] : undefined;

/** Visible text only: no scripts, styles or chrome, and nothing that differs between identical builds. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\b[0-9a-f]{8,}\b/gi, " ")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function fetchPage(url: string): Promise<{ status: Status; finalUrl?: string; hash?: string }> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404 || res.status === 410) return { status: "gone" };
    if (!res.ok) return { status: "error" };
    return { status: "ok", finalUrl: res.url, hash: hash(pageText(await res.text())) };
  } catch {
    return { status: "error" };
  }
}

async function terraformExists(address: string): Promise<"ok" | "gone" | undefined> {
  try {
    const res = await fetch(`https://registry.terraform.io/v1/providers/${address}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.status === 404 ? "gone" : res.ok ? "ok" : undefined;
  } catch {
    return undefined;
  }
}

/** Same page after a redirect, or just a different scheme/trailing slash? */
const samePage = (a: string, b: string) => a.replace(/^http:/, "https:").replace(/\/$/, "") === b.replace(/^http:/, "https:").replace(/\/$/, "");

async function main() {
  const saas = (await Bun.file(saasFile).json()) as SaasEntry[];
  const before = (await Bun.file(watchFile).exists()) ? ((await Bun.file(watchFile).json()) as Record<string, Watch>) : {};
  const after: Record<string, Watch> = { ...before };
  const now = new Date().toISOString();
  const moved: string[] = [], gone: string[] = [], changed: string[] = [], tfGone: string[] = [];

  const queue = saas.filter((e) => !SKIP.has(e.id));
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const prev = before[e.id];
        const page = await fetchPage(e.docs);
        const tf = e.terraform ? await terraformExists(e.terraform) : undefined;
        const next: Watch = { url: e.docs, status: page.status, checkedAt: now, ...(prev?.changedAt ? { changedAt: prev.changedAt } : {}) };

        if (page.status === "ok") {
          next.hash = page.hash;
          if (page.finalUrl && !samePage(page.finalUrl, e.docs)) {
            moved.push(`${e.name}: ${e.docs} → ${page.finalUrl}`);
            e.docs = next.url = page.finalUrl;
          }
          if (prev?.hash && prev.hash !== page.hash) {
            changed.push(`${e.name}: ${e.docs}`);
            next.changedAt = now;
          }
        } else if (page.status === "gone") {
          if (prev?.status !== "gone") gone.push(`${e.name}: ${e.docs}`);
        } else if (prev?.hash) {
          // A network error or 5xx says nothing about the page; keep what we knew.
          next.hash = prev.hash;
        }
        if (tf) next.terraform = tf;
        if (tf === "gone" && prev?.terraform !== "gone") tfGone.push(`${e.name}: ${e.terraform}`);
        after[e.id] = next;
      }
    }),
  );

  const sorted = Object.fromEntries(Object.entries(after).sort(([a], [b]) => a.localeCompare(b)));
  await Bun.write(watchFile, `${JSON.stringify(sorted, null, 2)}\n`);
  if (moved.length) await Bun.write(saasFile, `${JSON.stringify(saas, null, 2)}\n`);

  const section = (title: string, items: string[], note: string) => (items.length ? [`### ${title} (${items.length})`, note, "", ...items.map((i) => `- ${i}`), ""] : []);
  const report = [
    "Weekly check of every provider in the catalog against its live docs and the Terraform Registry.",
    "",
    ...section("Docs moved", moved, "Updated in saas.json automatically (the old URL redirects here)."),
    ...section("Docs gone", gone, "Find the new page and update `docs` in saas.json."),
    ...section("Docs changed", changed, "Re-read the page: does `apiKeyCreation`, `managementApi` or `auth` still hold? Update saas.json if not."),
    ...section("Terraform provider gone", tfGone, "Set `terraform` to the new address, or null."),
  ];
  if (!moved.length && !gone.length && !changed.length && !tfGone.length) report.push("Nothing changed.");
  const text = report.join("\n");
  if (reportFile) await Bun.write(reportFile, text);
  console.log(text);
}

if (import.meta.main) await main();
