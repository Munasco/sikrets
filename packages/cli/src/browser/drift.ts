import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { FILES, REPO_URL } from "../constants.ts";
import { configDir } from "../store.ts";
import pkg from "../../package.json";

// When a provider's site no longer matches a flow (signed in, but an expected element or page is
// gone), Sikrets keeps a local record and offers a prefilled issue, so the flow can be fixed in
// the next release. Nothing is sent anywhere on its own, and the record holds no page content.
// The log is append-only, one line per occurrence; the issue link is offered once per flow, step
// and CLI version (the line that offered it carries reportedAt).

export interface Drift {
  flow: string;
  step: string;
  /** Origin and path only: query strings and fragments can carry tokens. */
  page: string;
  message: string;
  version: string;
  at: string;
  /** Set on the occurrence whose issue link was shown; later ones of the same drift aren't re-offered. */
  reportedAt?: string;
}

/** What a failed step tells us about the page, before knowing whether the person is signed in. */
export type Evidence = "missing" | "unexpected-page" | "unexpected-output" | "timeout" | "driver";

/**
 * The one rule for "the provider's site changed": the page lacked what the flow expects (an
 * element, the right page, output of the right shape) while the person was confirmed signed in.
 * Signed out, it's a lost session. Timeouts, network and browser failures, and an unknown sign-in
 * state are never drift: those say nothing about the site.
 */
export function classify(evidence: Evidence, signedIn: boolean | undefined): Evidence | "site-changed" | "signed-out" {
  if (evidence === "timeout" || evidence === "driver" || signedIn === undefined) return evidence;
  return signedIn ? "site-changed" : "signed-out";
}

const file = () => path.join(configDir(), FILES.drift);
const key = (d: Pick<Drift, "flow" | "step" | "version">) => `${d.flow}\u0000${d.step}\u0000${d.version}`;

export const pageOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
};

/** Appends an occurrence. `report` is true only the first time this drift is seen in this CLI version. */
export async function recordDrift(d: Omit<Drift, "version" | "at" | "page" | "reportedAt"> & { url: string }): Promise<{ drift: Drift; report: boolean }> {
  const at = new Date().toISOString();
  const base = { flow: d.flow, step: d.step, page: pageOf(d.url), message: d.message, version: pkg.version, at };
  const report = !(await driftLog()).some((e) => e.reportedAt && key(e) === key(base));
  const drift: Drift = report ? { ...base, reportedAt: at } : base;
  await mkdir(configDir(), { recursive: true });
  await appendFile(file(), `${JSON.stringify(drift)}\n`);
  return { drift, report };
}

/** Every occurrence. A torn line (a crash mid-append) or a hand edit is skipped, not fatal. */
export async function driftLog(): Promise<Drift[]> {
  const f = Bun.file(file());
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const d = JSON.parse(line) as Drift;
        return typeof d?.flow === "string" && typeof d.step === "string" ? [d] : [];
      } catch {
        return [];
      }
    });
}

/** A GitHub issue link with the drift filled in; the person decides whether to open it. */
export function driftIssueUrl(d: Drift): string {
  const title = `Site changed: ${d.flow} (${d.step})`;
  const body = [`Flow: ${d.flow}`, `Step: ${d.step}`, `Page: ${d.page}`, `Error: ${d.message}`, `CLI: ${d.version}`, `When: ${d.at}`].join("\n");
  return `${REPO_URL}/issues/new?${new URLSearchParams({ title, body, labels: "site-drift" })}`;
}
