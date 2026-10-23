import { click, pause, type } from "../browser/human.ts";
import type { Provider } from "./types.ts";
import { PROVIDER_URLS } from "../constants.ts";

// x.com is the canary for bot detection: if this flow gets through, gentler dashboards will too.
export const x: Provider = {
  id: "x",
  name: "X",
  loginUrl: PROVIDER_URLS.x.login,

  isLoggedIn: async (page) => /^https:\/\/(www\.)?x\.com\/home/.test(page.url()),

  async login(page, creds, step) {
    step("Waiting for the sign-in dialog");
    const username = page.locator('input[name="username_or_email"], input[autocomplete~="username"]').first();
    await username.waitFor({ timeout: 30_000 });
    await pause(1200, 400);

    step("Typing email");
    await type(page, username, creds.email);
    step("Continue");
    await click(page, page.getByRole("button", { name: /^(Continue|Next)$/ }).first());

    // X sometimes asks for the @handle or phone before the password; that check is left to you.
    const password = page.locator('input[name="password"]');
    const extraCheck = page.locator('input[data-testid="ocfEnterTextTextInput"]');
    await Promise.race([password.waitFor({ timeout: 20_000 }).catch(() => {}), extraCheck.waitFor({ timeout: 20_000 }).catch(() => {})]);
    if (await extraCheck.isVisible()) {
      step("X is asking for an extra check — answer it in the browser window");
      await password.waitFor({ timeout: 180_000 });
    }

    await pause(800, 300);
    step("Typing password");
    await type(page, password, creds.password);
    step("Log in");
    await click(page, page.getByRole("button", { name: /^(Log in|Continue)$/ }).first());
  },
};
