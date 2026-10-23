import { click, pause, type } from "../../browser/human.ts";
import { promptHidden } from "../../ui.ts";
import type { Provider } from "../types.ts";

// Upstash only needs the browser once: to mint a Developer API key. Everything after that
// (create, delete, reset password, billing) goes through api.upstash.com.
export const upstash: Provider = {
  id: "upstash",
  name: "Upstash",
  loginUrl: "https://console.upstash.com/login",

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
  async afterLogin(page, step) {
    try {
      step("Opening Account → Developer API");
      await page.goto("https://console.upstash.com/account/api", { waitUntil: "domcontentloaded" });
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
      if (key) return { "api-key": key };
    } catch {
      /* fall through to manual */
    }
    step("Couldn't read the key automatically — create it in the window and paste it here");
    return { "api-key": await promptHidden("Upstash Developer API key: ") };
  },
};
