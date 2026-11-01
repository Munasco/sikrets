import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { privateDir } from "../core/fs.ts";
import { sameOrigin } from "../core/logins/origin.ts";
import type { Login } from "../core/logins/store.ts";
import { parseTotp, totpCode } from "../core/logins/totp.ts";
import { redact, type Secret } from "../core/secret.ts";
import { configDir } from "../store.ts";
import { LOGINS } from "../constants.ts";

// Signs the agent's browser in to a site with a stored login. The agent and Sikrets share one
// Chrome over the DevTools protocol: the agent browses, and when it reaches a sign-in page it asks
// Sikrets to sign in. Sikrets fills the page's own form (username, password, then a TOTP code if
// the site asks) and reports only whether it worked.
//
// Guarantees: nothing is filled unless the page's origin is exactly the login's origin, checked
// before every step; forms that would post somewhere else are refused; only the top frame is
// filled, never an iframe; and if sign-in fails, the filled fields are emptied before returning.
//
// What this does not stop: an agent that drives the same browser can run script in the page while
// Sikrets fills it. Pair this with a browser tool that can't evaluate arbitrary script when that matters.

export type SignInResult = { ok: true; steps: string[] } | { ok: false; error: string };

/** The browser the agent drives: its open pages, and a way to open one. */
export interface AgentBrowser {
  pages(): Page[];
  newPage(): Promise<Page>;
}

// Fields by role. Only visible, editable inputs in the top frame count.
const EDITABLE = ":visible:not([disabled]):not([readonly])";
const PASSWORD = `input[type="password"]${EDITABLE}`;
const OTP = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="totp" i]',
  'input[name*="2fa" i]',
  'input[name*="mfa" i]',
  'input[name*="code" i]',
  'input[id*="otp" i]',
  'input[id*="code" i]',
]
  .map((s) => `${s}:not([type="password"]):not([type="hidden"])${EDITABLE}`)
  .join(", ");
const USERNAME = [
  'input[autocomplete~="username"]',
  'input[autocomplete~="email"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
]
  .map((s) => `${s}:not([type="password"]):not([type="hidden"]):not([autocomplete="one-time-code"])${EDITABLE}`)
  .join(", ");
const SUBMIT = 'button[type="submit"], input[type="submit"], button:not([type])';

/**
 * Connects to the Chrome the agent uses, at a DevTools endpoint. If nothing is listening there,
 * starts Chrome with Sikrets' agent profile and that debugging port, so the agent's browser tool
 * can attach to the same window.
 */
export async function connectAgentBrowser(endpoint: string): Promise<AgentBrowser> {
  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 3_000 });
    const context = () => browser.contexts()[0] ?? null;
    return {
      pages: () => browser.contexts().flatMap((c) => c.pages()),
      newPage: async () => (context() ?? (await browser.newContext())).newPage(),
    };
  } catch {
    const port = new URL(endpoint).port;
    const profile = path.join(configDir(), "browser", LOGINS.browserProfile);
    await privateDir(profile);
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: [`--remote-debugging-port=${port}`],
    });
    return { pages: () => context.pages(), newPage: () => context.newPage() };
  }
}

/** The page the agent is looking at: the last visible tab, else the last tab. */
async function currentPage(browser: AgentBrowser): Promise<Page | undefined> {
  const pages = browser.pages().filter((p) => !p.isClosed());
  for (const page of [...pages].reverse()) {
    const visible = await page.evaluate(() => document.visibilityState === "visible").catch(() => false);
    if (visible) return page;
  }
  return pages.at(-1);
}

const isBlank = (url: string) => url === "about:blank" || url.startsWith("chrome://newtab") || url.startsWith("chrome://new-tab-page");

async function first(page: Page, selector: string): Promise<Locator | undefined> {
  const loc = page.locator(selector).first();
  return (await loc.count()) ? loc : undefined;
}

/** Where submitting this field's form would send it: the form's action, or the page itself. */
const formTarget = (field: Locator) => field.evaluate((el) => ((el as HTMLInputElement).form?.action || location.href) as string);

/**
 * Submits, then waits for the step to land: the field goes away, or the page navigates, or time
 * runs out. The navigation listener starts before the submit so a fast response isn't missed.
 */
async function submitAndSettle(page: Page, field: Locator, submit: () => Promise<void>, timeoutMs: number) {
  const navigated = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: timeoutMs });
  navigated.catch(() => undefined);
  await submit();
  await Promise.race([field.waitFor({ state: "hidden", timeout: timeoutMs }), navigated]).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForTimeout(250); // let client-side frameworks render the next step
}

export async function signIn(browser: AgentBrowser, login: Login, opts: { timeoutMs?: number; now?: () => number } = {}): Promise<SignInResult> {
  const timeoutMs = opts.timeoutMs ?? LOGINS.stepTimeoutMs;
  const secrets: Secret[] = [login.username, login.password, ...(login.totpSecret ? [login.totpSecret] : [])];
  let page = await currentPage(browser);
  if (!page) page = await browser.newPage();
  if (isBlank(page.url())) await page.goto(login.origin, { waitUntil: "domcontentloaded", timeout: timeoutMs });

  const steps: string[] = [];
  const done = new Set<"username" | "password" | "otp">();
  const offOrigin = () => `This page is on ${new URL(page.url()).origin || page.url()}, not ${login.origin}. Sikrets only fills ${login.name} on ${login.origin}.`;

  // Empties every field Sikrets may have filled, so a failed attempt leaves nothing to read.
  const clear = async () => {
    for (const selector of [PASSWORD, OTP]) for (const field of await page.locator(selector).all()) await field.fill("").catch(() => undefined);
  };
  const fail = async (error: string): Promise<SignInResult> => {
    await clear();
    return { ok: false, error: redact(error, secrets) };
  };

  const submit = async (field: Locator) => {
    const form = field.locator("xpath=ancestor::form[1]");
    const button = (await form.count()) ? form.locator(SUBMIT).filter({ visible: true }).first() : undefined;
    const press = button && (await button.count()) ? () => button.click({ timeout: timeoutMs }) : () => field.press("Enter");
    await submitAndSettle(page, field, press, timeoutMs);
  };

  try {
    for (let step = 0; step < 4; step++) {
      if (!sameOrigin(page.url(), login.origin)) {
        if (done.has("password")) break; // sites often send you elsewhere once you're in; nothing more is filled there
        return fail(offOrigin());
      }
      const password = await first(page, PASSWORD);
      const otp = password ? undefined : await first(page, OTP);
      const username = otp ? undefined : await first(page, USERNAME);
      const field = password ?? otp ?? username;
      if (!field) break;
      if (!sameOrigin(await formTarget(field), login.origin)) return fail(`The form on this page posts to ${new URL(await formTarget(field)).origin}, not ${login.origin}. Refusing to fill it.`);

      if (password) {
        if (done.has("password")) return fail("The site didn't accept the sign-in: it's asking for the password again.");
        if (username && !done.has("username")) await username.fill(login.username.reveal());
        await password.fill(login.password.reveal());
        done.add("password").add("username");
        steps.push("password");
        await submit(password);
      } else if (otp) {
        if (done.has("otp")) return fail("The site didn't accept the one-time code.");
        if (!login.totpSecret) return fail(`The site asks for a one-time code, but ${login.name} has no TOTP secret. Add one with: sikrets logins add ${login.name} ${login.origin} --totp`);
        await otp.fill(totpCode(parseTotp(login.totpSecret), opts.now?.()).reveal());
        done.add("otp");
        steps.push("one-time code");
        await submit(otp);
      } else if (username) {
        if (done.has("username")) break; // a username field on the signed-in page (search, profile) isn't a login step
        await username.fill(login.username.reveal());
        done.add("username");
        steps.push("username");
        await submit(username);
      }
    }
    if (!done.has("password")) return fail(done.size ? "The site never showed a password field." : "No sign-in form on this page. Open the site's sign-in page first.");
    if (!sameOrigin(page.url(), login.origin)) return { ok: true, steps };
    if (await first(page, PASSWORD)) return fail("The site didn't accept the sign-in: it's asking for the password again.");
    if (await first(page, OTP)) return fail("The site is still asking for a one-time code.");
    return { ok: true, steps };
  } catch (error) {
    return fail(`Sign-in stopped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}
