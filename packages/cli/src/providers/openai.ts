import { click, pause, type } from "../browser/human.ts";
import type { Provider } from "./types.ts";

export const openai: Provider = {
  id: "openai",
  name: "OpenAI",
  loginUrl: "https://platform.openai.com/login",

  isLoggedIn: async (page) => {
    const url = new URL(page.url());
    return url.hostname === "platform.openai.com" && !url.pathname.startsWith("/login");
  },

  async login(page, creds, step) {
    step("Waiting for the email field");
    const email = page.locator('input[type="email"], input[name="email"]').first();
    await email.waitFor({ timeout: 30_000 });
    await pause(1000, 300);

    step("Typing email");
    await type(page, email, creds.email);
    step("Continue");
    await click(page, page.getByRole("button", { name: "Continue", exact: true }));

    const password = page.locator('input[type="password"]').first();
    await password.waitFor({ timeout: 20_000 });
    await pause(800, 300);
    step("Typing password");
    await type(page, password, creds.password);
    step("Continue");
    await click(page, page.getByRole("button", { name: "Continue", exact: true }));
  },
};
