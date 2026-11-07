import { click, pause, type } from "../../browser/human.ts";
import { promptHidden } from "../../ui.ts";
import type { Page } from "playwright-core";
import type { Provider, Step } from "../types.ts";
import { PROVIDER_URLS, USER_AGENT } from "../../constants.ts";

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
  mint: { key: "api-key", manageUrl: PROVIDER_URLS.upstash.apiKeys, run: mintApiKey, verify: verifyApiKey },
};

async function verifyApiKey(email: string, key: string) {
  const res = await fetch(`${PROVIDER_URLS.upstash.api}/redis/databases?credentials=hide`, {
    headers: { Authorization: `Basic ${btoa(`${email}:${key}`)}`, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Upstash rejected the new API key");
  if (!res.ok) throw new Error(`Couldn't check the new API key: Upstash answered HTTP ${res.status}`);
}

async function mintApiKey(page: Page, step: Step, name: string): Promise<string> {
  try {
      step("Opening Account → Developer API");
      await page.goto(PROVIDER_URLS.upstash.apiKeys, { waitUntil: "domcontentloaded" });
      await pause(1500, 400);
      step("Create API Key");
      await click(page, page.getByRole("button", { name: /Create API Key/i }).first());
      await pause(800, 300);
      step("Naming the key");
      await type(page, page.getByRole("dialog").locator("input").first(), name);
      step("Submit");
      await click(page, page.getByRole("dialog").getByRole("button", { name: /Submit|Create/i }).first());
      // The key is shown once; read the longest token-looking string in the dialog.
      const text = await page.getByRole("dialog").innerText({ timeout: 15_000 });
      const key = text.match(/[A-Za-z0-9_-]{30,}/g)?.sort((a, b) => b.length - a.length)[0];
      if (key) return key;
  } catch {
    /* fall through to manual */
  }
  step("Couldn't read the key automatically — create it in the window and paste it here");
  return promptHidden("Upstash Developer API key: ");
}
