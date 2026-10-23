import { chromium, type BrowserContext } from "playwright-core";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { configDir } from "../store.ts";

// One persistent Chrome profile per provider, so a login made once (by you or by a flow)
// is reused the next time a flow needs that dashboard.
export async function openBrowser(provider: string, opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  const profile = path.join(configDir(), "browser", provider);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: opts.headless ?? false,
    viewport: null,
    args: ["--start-maximized"],
  });
}
