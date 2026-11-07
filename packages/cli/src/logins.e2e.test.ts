import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "./commands/mcp.ts";
import { listGrants, type Decision } from "./core/logins/grants.ts";
import type { Login } from "./core/logins/store.ts";
import { parseTotp, totpCode } from "./core/logins/totp.ts";
import { Secret } from "./core/secret.ts";
import { ENV } from "./constants.ts";

// End to end: a local site with a fake account and 2FA, the installed Google Chrome (headless),
// and the MCP `login` tool driving it over the DevTools protocol, the way an agent's browser tool
// and Sikrets share one Chrome. Every value here is fake.

const USER = "fake-user@example.test";
const PASSWORD = "fake-password-not-real-0001";
const TOTP_SECRET = "JBSWY3DPEHPK3PXPFAKE2345";

const page = (title: string, body: string) =>
  new Response(`<!doctype html><title>${title}</title><body>${body}</body>`, { headers: { "content-type": "text/html" } });
const form = (action: string, fields: string) => `<form method="post" action="${action}">${fields}<button type="submit">Continue</button></form>`;

function site(evilOrigin: () => string) {
  const sessions = new Set<string>();
  const pending = new Set<string>();
  const cookie = (req: Request, name: string) => req.headers.get("cookie")?.match(new RegExp(`${name}=([^;]+)`))?.[1];
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/login" && req.method === "GET")
        return page("Sign in", form("/login", `<label>Email <input type="email" name="email" autocomplete="username"></label><label>Password <input type="password" name="password"></label>`));
      if (url.pathname === "/login-away" && req.method === "GET")
        return page("Sign in", form("/login-away", `<input type="email" name="email" autocomplete="username"><input type="password" name="password">`));
      // Sends you off to another origin after the password, whether it was right or not.
      if (url.pathname === "/login-away" && req.method === "POST") return Response.redirect(`${evilOrigin()}/somewhere`, 303);
      if (url.pathname === "/login-elsewhere") return page("Sign in", form(`${evilOrigin()}/steal`, `<input type="email" name="email"><input type="password" name="password">`));
      if (url.pathname === "/login" && req.method === "POST") {
        const f = await req.formData();
        if (f.get("email") !== USER || f.get("password") !== PASSWORD) return page("Sign in", `<p>Wrong email or password</p>${form("/login", `<input type="email" name="email"><input type="password" name="password">`)}`);
        const id = crypto.randomUUID();
        pending.add(id);
        return new Response(null, { status: 303, headers: { location: "/2fa", "set-cookie": `pending=${id}; HttpOnly; Path=/` } });
      }
      if (url.pathname === "/2fa" && req.method === "GET") return page("Two-factor", form("/2fa", `<label>Code <input name="otp" inputmode="numeric" autocomplete="one-time-code"></label>`));
      if (url.pathname === "/2fa" && req.method === "POST") {
        const id = cookie(req, "pending");
        const code = String((await req.formData()).get("otp"));
        const config = parseTotp(Secret.of(TOTP_SECRET));
        const valid = [-30_000, 0, 30_000].some((d) => totpCode(config, Date.now() + d).reveal() === code);
        if (!id || !pending.has(id) || !valid) return page("Two-factor", `<p>Wrong code</p>${form("/2fa", `<input name="otp" autocomplete="one-time-code">`)}`);
        pending.delete(id);
        sessions.add(id);
        return new Response(null, { status: 303, headers: { location: "/home", "set-cookie": `session=${id}; HttpOnly; Path=/` } });
      }
      if (url.pathname === "/home") {
        const id = cookie(req, "session");
        return id && sessions.has(id) ? page("Home", `<h1>Welcome back</h1><input type="search" name="username-search">`) : Response.redirect(`${url.origin}/login`, 303);
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// Installed Google Chrome only; nothing is downloaded. Without it, these tests are skipped.
const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const cdp = `http://127.0.0.1:${free.port}`;
free.stop(true);
const browser: Browser | undefined = await chromium.launch({ channel: "chrome", headless: true, args: [`--remote-debugging-port=${new URL(cdp).port}`] }).catch(() => undefined);

let agent: Browser;
let tab: Page;
let real: ReturnType<typeof Bun.serve>;
let evil: ReturnType<typeof Bun.serve>;
let dir: string;
let decision: Decision;
let asked = 0;

const login = (over: Partial<Login> = {}): Login => ({
  name: "testsite",
  origin: real.url.origin,
  totp: true,
  addedAt: new Date().toISOString(),
  username: Secret.of(USER),
  password: Secret.of(PASSWORD),
  totpSecret: Secret.of(TOTP_SECRET),
  ...over,
});

const servers: ReturnType<typeof createServer>[] = [];
const server = (stored: Login = login()) => {
  const s = createServer({
    root: dir,
    allow: [],
    loadEnv: async () => ({}),
    agent: "e2e-agent",
    identify: async (name) => ({ name, id: "test:e2e" }),
    logins: {
      browser: cdp,
      getLogin: async (name) => (name === stored.name ? stored : undefined),
      listLogins: async () => [{ name: stored.name, origin: stored.origin }],
      approve: async () => (asked++, decision),
    },
  });
  servers.push(s);
  return s;
};

async function call(s: ReturnType<typeof server>, args: Record<string, unknown>) {
  const reply = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "login", arguments: args } })) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return { text: reply.result.content[0]!.text, isError: reply.result.isError };
}

const leaked = (text: string) => [PASSWORD, TOTP_SECRET, USER].some((v) => text.includes(v));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-logins-e2e-"));
  Bun.env[ENV.configDir] = dir;
  evil = Bun.serve({ port: 0, fetch: () => page("Sign in", form("/steal", `<input type="email" name="email"><input type="password" name="password">`)) });
  real = site(() => evil.url.origin);
  if (!browser) return;
  // The "agent" attaches over CDP like a browser MCP server would, and keeps one tab.
  agent = await chromium.connectOverCDP(cdp);
  tab = await agent.contexts()[0]!.newPage();
}, 30_000);

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

afterAll(async () => {
  await agent?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  real?.stop(true);
  evil?.stop(true);
  delete Bun.env[ENV.configDir];
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await agent?.contexts()[0]!.clearCookies();
  decision = "once";
  asked = 0;
});

describe.skipIf(!browser)("MCP login tool, end to end", () => {
  test("signs in with password and TOTP, and says only that it did", async () => {
    await tab.goto(`${real.url.origin}/login`);
    const { text, isError } = await call(server(), { site: "testsite" });
    expect(isError).toBe(false);
    expect(text).toBe(`Signed in to testsite (${real.url.origin}).`);
    expect(leaked(text)).toBe(false);
    expect(new URL(tab.url()).pathname).toBe("/home");
    expect(await tab.textContent("h1")).toBe("Welcome back");
    expect(asked).toBe(1);
  }, 30_000);

  test("refuses a lookalike page on another origin and fills nothing", async () => {
    await tab.goto(`${evil.url.origin}/login`);
    const { text, isError } = await call(server(), { site: "testsite" });
    expect(isError).toBe(true);
    expect(text).toContain(`not ${real.url.origin}`);
    expect(leaked(text)).toBe(false);
    expect(await tab.inputValue('input[type="password"]')).toBe("");
    expect(await tab.inputValue('input[type="email"]')).toBe("");
  }, 30_000);

  test("refuses a form on the right origin that posts to another one", async () => {
    await tab.goto(`${real.url.origin}/login-elsewhere`);
    const { text, isError } = await call(server(), { site: "testsite" });
    expect(isError).toBe(true);
    expect(text).toContain("posts to");
    expect(await tab.inputValue('input[type="password"]')).toBe("");
  }, 30_000);

  test("a wrong password fails cleanly and leaves no value in the page", async () => {
    await tab.goto(`${real.url.origin}/login`);
    const { text, isError } = await call(server(login({ password: Secret.of("fake-wrong-password-0002") })), { site: "testsite" });
    expect(isError).toBe(true);
    expect(text).toContain("didn't accept");
    expect(text).not.toContain("fake-wrong-password-0002");
    for (const field of await tab.locator("input").all()) expect(await field.inputValue()).not.toContain("fake-wrong-password-0002");
  }, 30_000);

  test("a site asking for a code without a stored TOTP secret is an error, not a guess", async () => {
    await tab.goto(`${real.url.origin}/login`);
    const { text, isError } = await call(server(login({ totp: false, totpSecret: undefined })), { site: "testsite" });
    expect(isError).toBe(true);
    expect(text).toContain("no TOTP secret");
  }, 30_000);

  test("deny stops before the browser is touched; allow for this agent is asked once", async () => {
    await tab.goto(`${real.url.origin}/login`);
    decision = "deny";
    const denied = await call(server(), { site: "testsite" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("didn't allow e2e-agent");
    expect(await tab.inputValue('input[type="password"]')).toBe("");

    decision = "always";
    expect((await call(server(), { site: "testsite" })).isError).toBe(false);
    await agent.contexts()[0]!.clearCookies();
    await tab.goto(`${real.url.origin}/login`);
    expect((await call(server(), { site: "testsite" })).isError).toBe(false);
    expect(asked).toBe(2);
    expect((await listGrants()).map((g) => `${g.login}:${g.agent}`)).toEqual(["testsite:e2e-agent"]);
  }, 60_000);

  test("a site that leaves the origin after the password is reported as unconfirmed, not signed in", async () => {
    await tab.goto(`${real.url.origin}/login-away`);
    const { text, isError } = await call(server(), { site: "testsite" });
    expect(isError).toBe(false);
    expect(text).toContain("couldn't confirm");
    expect(text).not.toContain("Signed in");
    expect(leaked(text)).toBe(false);
  }, 30_000);

  test("with no site, lists login names and origins only", async () => {
    const { text } = await call(server(), {});
    expect(text).toBe(`testsite  ${real.url.origin}`);
  });
});
