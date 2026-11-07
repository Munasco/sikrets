import { click, pause, type } from "../../browser/human.ts";
import { promptHidden } from "../../ui.ts";
import type { Page } from "playwright-core";
import type { Provider, Step } from "../types.ts";
import type { Evidence } from "../../browser/drift.ts";
import { FlowError } from "../../browser/flow.ts";
import { PROVIDER_URLS } from "../../constants.ts";

// Upstash only needs the browser once: to mint a Developer API key. Everything after that
// (create, delete, reset password, billing) goes through api.upstash.com.
export const upstash: Provider = {
  id: "upstash",
  name: "Upstash",
  loginUrl: PROVIDER_URLS.upstash.login,

  isLoggedIn: async (page) => {
    const url = new URL(page.url());
    return url.hostname === "console.upstash.com" && !/^\/(login|auth|signup)/.test(url.pathname);
  },

  async login(page, creds, step) {
    step("Waiting for the email field");
    const email = page.locator('input[type="email"], input[name="email"]').first();
    await email.waitFor({ timeout: 30_000 });
    await pause(900, 300);
    step("Typing email");
    await type(page, email, creds.email);
    const password = page.locator('input[type="password"]').first();
    if (!(await password.isVisible())) {
      step("Continue");
      await click(page, page.getByRole("button", { name: /^(Continue|Next|Sign in|Log in)$/i }).first());
      await password.waitFor({ timeout: 20_000 });
    }
    await pause(700, 250);
    step("Typing password");
    await type(page, password, creds.password);
    step("Sign in");
    await click(page, page.getByRole("button", { name: /^(Sign in|Log in|Continue)$/i }).first());
  },

  // Follows Upstash's documented path: Account → Developer API → Create API Key.
  mint: { key: "api-key", run: mintApiKey },
};

/**
 * What a failure says about the page. A Playwright wait that timed out on a fully loaded page means
 * the element isn't there; on a page still loading it's just slow. Anything else is the browser.
 */
export async function evidence(page: Pick<Page, "evaluate">, error: unknown): Promise<Evidence> {
  if (error instanceof FlowError && (error.kind === "missing" || error.kind === "unexpected-page" || error.kind === "unexpected-output" || error.kind === "timeout")) return error.kind;
  if (error instanceof Error && error.name === "TimeoutError") {
    const ready = await page.evaluate(() => document.readyState).catch(() => undefined);
    return ready === "complete" ? "missing" : "timeout";
  }
  return "driver";
}

async function mintApiKey(page: Page, report: Step): Promise<string> {
  let at = "";
  const step: Step = (m) => report((at = m));
  try {
      step("Opening Account → Developer API");
      await page.goto(PROVIDER_URLS.upstash.apiKeys, { waitUntil: "domcontentloaded" });
      await pause(1500, 400);
      step("Create API Key");
      await click(page, page.getByRole("button", { name: /Create API Key/i }).first());
      await pause(800, 300);
      step("Naming the key");
      await type(page, page.getByRole("dialog").locator("input").first(), `sikrets-${new Date().toISOString().slice(0, 10)}`);
      step("Submit");
      await click(page, page.getByRole("dialog").getByRole("button", { name: /Submit|Create/i }).first());
      // The key is shown once; read the longest token-looking string in the dialog.
      const text = await page.getByRole("dialog").innerText({ timeout: 15_000 });
      const key = text.match(/[A-Za-z0-9_-]{30,}/g)?.sort((a, b) => b.length - a.length)[0];
      if (key) return key;
      throw new FlowError("unexpected-output", at, "the dialog no longer shows a key");
  } catch (error) {
    // Same rule as every flow (drift.ts classify): only a missing element or wrong output while
    // confirmed signed in is a dashboard change. A slow page or a dead browser is not.
    const { classify, driftIssueUrl, recordDrift } = await import("../../browser/drift.ts");
    const kind = classify(await evidence(page, error), await upstash.isLoggedIn(page).catch(() => undefined));
    if (kind === "site-changed") {
      const { drift, report: first } = await recordDrift({ flow: "upstash/api-key", step: at, url: page.url(), message: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      if (first) report(`Upstash's dashboard looks different from what Sikrets expects. Report it (prefilled, nothing sent until you submit): ${driftIssueUrl(drift)}`);
    }
  }
  step("Couldn't read the key automatically — create it in the window and paste it here");
  return promptHidden("Upstash Developer API key: ");
}
