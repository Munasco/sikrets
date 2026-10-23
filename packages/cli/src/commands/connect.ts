import type { Page } from "playwright-core";
import { openBrowser } from "../browser/session.ts";
import { connectAws } from "../providers/aws.ts";
import { provider as getProvider } from "../providers/index.ts";
import type { Credentials, Provider } from "../providers/types.ts";
import { keychain, listConnections, saveConnection, type Connection } from "../store.ts";
import { log, promptHidden, promptLine } from "../ui.ts";

export interface ConnectOptions {
  email?: string;
  passwordStdin?: boolean;
  /** Mint a fresh API key even if one is stored (old keys stay valid until revoked in the dashboard). */
  renew?: boolean;
  json?: boolean;
}

/**
 * Two ways to connect:
 *  - watch (default): a visible browser opens, you sign in yourself, and Sikrets saves what you
 *    typed into the login form to your OS keychain so it can sign in again later on its own.
 *  - terminal (--email): you give the email and password up front and Sikrets types them in.
 * Either way, anything the script can't do (2FA, captchas, "is this you?") you finish in the window.
 */
export async function run(args: string[], opts: Record<string, unknown>) {
  const id = args[0]!;
  if (id === "aws") {
    const result = await connectAws(typeof opts.profile === "string" ? opts.profile : (Bun.env.AWS_PROFILE ?? "default"), (m) => log(opts, m));
    if (opts.json) console.log(JSON.stringify({ provider: "aws", ...result, connected: true }));
    return;
  }
  return connect(id, {
    email: typeof opts.email === "string" ? opts.email : undefined,
    passwordStdin: Boolean(opts["password-stdin"]),
    renew: Boolean(opts.renew),
    json: Boolean(opts.json),
  });
}

export async function connect(id: string, opts: ConnectOptions) {
  const p = getProvider(id);
  const known = (await listConnections()).find((c) => c.provider === p.id);

  let creds: Credentials | undefined;
  let mode: Connection["mode"] = "watch";
  if (opts.email) {
    mode = "terminal";
    const password = opts.passwordStdin ? (await Bun.stdin.text()).trim() : await promptHidden(`${p.name} password: `);
    if (!password) throw new Error("No password given");
    creds = { email: opts.email, password };
  } else if (known) {
    const saved = await keychain.get(p.id, known.account);
    if (saved) creds = { email: known.account, password: saved };
  }

  const browser = await openBrowser(p.id);
  try {
    const page = browser.pages()[0] ?? (await browser.newPage());
    log(opts, `Opening ${p.name}`);
    await page.goto(p.loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    if (await p.isLoggedIn(page)) {
      log(opts, `Already signed in to ${p.name} in the Sikrets browser profile`);
    } else if (creds) {
      await p.login(page, creds, (s) => log(opts, `  ${s}`));
      await waitForLogin(page, p, opts);
    } else {
      const captured = captureLoginForm(page);
      log(opts, `Sign in to ${p.name} in the browser window. What you type into its login form is saved to your keychain.`);
      await waitForLogin(page, p, opts);
      creds = await captured.result();
    }

    // Social sign-ins (Google, GitHub) never show us an email; API-backed providers need one.
    const account = creds?.email ?? known?.account ?? (p.mint ? await promptLine(`${p.name} account email: `) : "default");
    if (creds) await keychain.set(p.id, creds.email, creds.password);
    let minted = false;
    if (p.mint && (opts.renew || !(await keychain.get(p.id, `${account}#${p.mint.key}`)))) {
      const value = await p.mint.run(page, (s) => log(opts, `  ${s}`));
      if (!value) throw new Error(`No ${p.mint.key} was created`);
      await keychain.set(p.id, `${account}#${p.mint.key}`, value);
      minted = true;
    }
    await saveConnection({ provider: p.id, account, mode: known?.mode ?? mode, connectedAt: new Date().toISOString() });

    if (opts.json) console.log(JSON.stringify({ provider: p.id, account, connected: true, savedPassword: Boolean(creds), mintedKey: minted }));
    else log(opts, `Connected ${p.name} as ${account}${creds ? "; password saved to keychain" : ""}${minted ? `; new ${p.mint!.key} saved to keychain` : ""}`);
  } finally {
    await browser.close();
  }
}

async function waitForLogin(page: Page, p: Provider, opts: ConnectOptions, timeoutMs = 10 * 60_000) {
  const end = Date.now() + timeoutMs;
  let nudged = false;
  while (Date.now() < end) {
    if (await p.isLoggedIn(page).catch(() => false)) return;
    if (!nudged && Date.now() > end - timeoutMs + 20_000) {
      log(opts, "  Waiting for sign-in to finish — complete any remaining step in the browser window");
      nudged = true;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`Timed out waiting for ${p.name} sign-in`);
}

/** Watches the provider's login form and remembers the last email and password typed into it. */
function captureLoginForm(page: Page) {
  let email = "";
  let password = "";
  void page.exposeFunction("__sikretsCapture", (field: string, value: string) => {
    if (field === "email") email = value;
    if (field === "password") password = value;
  });
  void page.addInitScript(() => {
    const send = (window as unknown as { __sikretsCapture: (f: string, v: string) => void }).__sikretsCapture;
    document.addEventListener(
      "input",
      (e) => {
        const el = e.target as HTMLInputElement;
        if (!(el instanceof HTMLInputElement)) return;
        if (el.type === "password") send("password", el.value);
        else if (el.type === "email" || /user|email|login/i.test(el.name + el.autocomplete)) send("email", el.value);
      },
      true,
    );
  });
  return { result: async () => (email && password ? { email, password } : undefined) };
}
