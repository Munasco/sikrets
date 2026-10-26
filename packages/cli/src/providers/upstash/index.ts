import { click, pause, type } from "../../browser/human.ts";
import { promptHidden } from "../../ui.ts";
import type { Page } from "playwright-core";
import type { Provider, Step } from "../types.ts";
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
      throw new Error("the dialog no longer shows a key");
  } catch (error) {
    // Still signed in but a step failed: Upstash's dashboard changed. Keep a record and offer an issue.
    if (await upstash.isLoggedIn(page).catch(() => false)) {
      const { driftIssueUrl, recordDrift } = await import("../../browser/drift.ts");
      const d = await recordDrift({ flow: "upstash/api-key", step: at, url: page.url(), message: error instanceof Error ? error.message.split("\n")[0]! : String(error) });
      report(`Upstash's dashboard looks different from what Sikrets expects. Report it (prefilled, nothing sent until you submit): ${driftIssueUrl(d)}`);
    }
  }
  step("Couldn't read the key automatically — create it in the window and paste it here");
  return promptHidden("Upstash Developer API key: ");
}
