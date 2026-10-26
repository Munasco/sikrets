import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { FILES, REPO_URL } from "../constants.ts";
import { configDir } from "../store.ts";
import pkg from "../../package.json";

// When a provider's site no longer matches a flow (signed in, but an expected element or page is
// gone), Sikrets keeps a local record and offers a prefilled issue, so the flow can be fixed in
// the next release. Nothing is sent anywhere on its own, and the record holds no page content.

export interface Drift {
  flow: string;
  step: string;
  /** Origin and path only: query strings and fragments can carry tokens. */
  page: string;
  message: string;
  version: string;
  at: string;
}

const file = () => path.join(configDir(), FILES.drift);

export const pageOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
};

export async function recordDrift(d: Omit<Drift, "version" | "at" | "page"> & { url: string }): Promise<Drift> {
  const entry: Drift = { flow: d.flow, step: d.step, page: pageOf(d.url), message: d.message, version: pkg.version, at: new Date().toISOString() };
  await mkdir(configDir(), { recursive: true });
  await appendFile(file(), `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function driftLog(): Promise<Drift[]> {
  const f = Bun.file(file());
  if (!(await f.exists())) return [];
  return (await f.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Drift);
}

/** A GitHub issue link with the drift filled in; the person decides whether to open it. */
export function driftIssueUrl(d: Drift): string {
  const title = `Site changed: ${d.flow} (${d.step})`;
  const body = [`Flow: ${d.flow}`, `Step: ${d.step}`, `Page: ${d.page}`, `Error: ${d.message}`, `CLI: ${d.version}`, `When: ${d.at}`].join("\n");
  return `${REPO_URL}/issues/new?${new URLSearchParams({ title, body, labels: "site-drift" })}`;
}
