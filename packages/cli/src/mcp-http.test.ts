import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler, serveHttp, type HttpOptions } from "./commands/mcp-http.ts";
import { clientIdentity, clientStore, type TokenVault } from "./core/mcp-clients.ts";
import { addGrant, listGrants } from "./core/logins/grants.ts";
import { Secret } from "./core/secret.ts";
import { ENV } from "./constants.ts";

const KEY = "fake-test-secret-0123456789abcdef";
const env = { STRIPE_KEY: Secret.of(KEY), REGION: "eu-west-1" };
const BASE = "http://127.0.0.1:7787";

let root: string;
let vault: Map<string, string>;
let store: ReturnType<typeof clientStore>;
const memoryVault = (): TokenVault => ({
  set: async (n, v) => void vault.set(n, v),
  get: async (n) => vault.get(n) ?? null,
  delete: async (n) => void vault.delete(n),
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-mcp-http-"));
  Bun.env[ENV.configDir] = root; // login grants live here too
  vault = new Map();
  store = clientStore({ dir: root, tokens: memoryVault() });
});
afterEach(async () => {
  delete Bun.env[ENV.configDir];
  await rm(root, { recursive: true, force: true });
});

const handler = (extra: Partial<HttpOptions> = {}) =>
  createHttpHandler({ root, allow: [], loadEnv: async () => env, host: "127.0.0.1", port: 7787, store, log: () => undefined, ...extra });

let nextId = 1;
function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", host: "127.0.0.1:7787", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("sikrets mcp --http: auth", () => {
  test("no token gives 401 with a Bearer challenge", async () => {
    const res = await handler().fetch(rpc("tools/list"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toStartWith("Bearer");
  });

  test("a wrong token is rejected", async () => {
    await store.add("cursor");
    const res = await handler().fetch(rpc("tools/list", {}, auth("sik_mcp_not-a-real-token")));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("a valid token works, and a revoked client is rejected on its next request", async () => {
    const token = (await store.add("cursor")).reveal();
    const h = handler();
    const ok = await h.fetch(rpc("tools/list", {}, auth(token)));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
    expect(await store.remove("cursor")).toBe(true);
    expect(vault.has("cursor")).toBe(false);
    expect((await h.fetch(rpc("tools/list", {}, auth(token)))).status).toBe(401);
  });

  test("tokens are stored as hashes only; the raw token lives in the vault", async () => {
    const token = (await store.add("claude-code")).reveal();
    const file = await Bun.file(path.join(root, "mcp-clients.json")).text();
    expect(file).not.toContain(token);
    expect(vault.get("claude-code")).toBe(token);
    expect((await store.token("claude-code"))?.reveal()).toBe(token);
  });

  test("foreign Host and Origin headers are refused (DNS rebinding)", async () => {
    const token = (await store.add("cursor")).reveal();
    expect((await handler().fetch(rpc("tools/list", {}, { ...auth(token), host: "evil.example:7787" }))).status).toBe(403);
    expect((await handler().fetch(rpc("tools/list", {}, { ...auth(token), origin: "https://evil.example" }))).status).toBe(403);
    expect((await handler().fetch(rpc("tools/list", {}, { ...auth(token), origin: "http://localhost:6274" }))).status).toBe(200);
  });

  test("each client is rate limited, and so are bad tokens", async () => {
    const token = (await store.add("cursor")).reveal();
    const h = handler();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await h.fetch(rpc("ping", {}, auth(token)))).status);
    expect(statuses).toContain(429);
    const bad: number[] = [];
    for (let i = 0; i < 15; i++) bad.push((await h.fetch(rpc("ping", {}, auth("wrong")), "10.0.0.9")).status);
    expect(bad.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(bad.at(-1)).toBe(429);
  });

  test("the token decides the agent name, not what the client claims", async () => {
    const token = (await store.add("cursor")).reveal();
    const asked: string[] = [];
    const h = handler({
      logins: {
        getLogin: async () => ({ name: "github", origin: "https://github.com" }) as never,
        approve: async ({ agent }) => (asked.push(agent), "deny"),
      },
    });
    await h.fetch(rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "trusted-agent", version: "1" } }, auth(token)));
    const res = (await (await h.fetch(rpc("tools/call", { name: "login", arguments: { site: "github" } }, auth(token)))).json()) as {
      result: { content: { text: string }[] };
    };
    expect(asked).toEqual(["cursor"]);
    expect(res.result.content[0]!.text).toContain("cursor");
  });
});

describe("sikrets mcp --http: no values over the wire", () => {
  test("every tool answers without the secret or the token", async () => {
    const token = (await store.add("cursor")).reveal();
    const h = handler();
    const script = `const k = process.env.STRIPE_KEY; console.log(k); console.log(Buffer.from(k).toString("base64")); console.error(encodeURIComponent(k))`;
    const bodies: string[] = [];
    for (const [name, args] of [
      ["list_secrets", {}],
      ["run_with_secrets", { command: [process.execPath, "-e", script] }],
      ["run_with_secrets", { command: [process.execPath, "-e", "throw new Error(process.env.STRIPE_KEY)"] }],
      ["recent_activity", {}],
    ] as const)
      bodies.push(await (await h.fetch(rpc("tools/call", { name, arguments: args }, { ...auth(token), accept: "application/json, text/event-stream" }))).text());
    const all = bodies.join("\n");
    expect(all).toContain("[secret:STRIPE_KEY]");
    for (const leak of [KEY, Buffer.from(KEY).toString("base64"), encodeURIComponent(KEY), token]) expect(all).not.toContain(leak);
  });
});

describe("sikrets mcp --http --oauth", () => {
  const PUBLIC = "https://sikrets-test.example.com";
  const oauth = (approve = true) => handler({ oauth: true, publicUrl: PUBLIC, approveConnect: async () => approve });
  const req = (p: string, init: RequestInit = {}) => new Request(`${PUBLIC}${p}`, { ...init, headers: { host: "sikrets-test.example.com", ...(init.headers ?? {}) } });
  const verifier = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";

  async function registerAndAuthorize(h: ReturnType<typeof oauth>) {
    const reg = (await (
      await h.fetch(req("/register", { method: "POST", body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) }))
    ).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${PUBLIC}/mcp` });
    const res = await h.fetch(req(`/authorize?${q}`));
    return { clientId: reg.client_id, location: new URL(res.headers.get("location")!) };
  }

  test("metadata points apps at the public URL", async () => {
    const h = oauth();
    const unauth = await h.fetch(req("/mcp", { method: "POST", body: "{}" }));
    expect(unauth.headers.get("www-authenticate")).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
    const pr = (await (await h.fetch(req("/.well-known/oauth-protected-resource/mcp"))).json()) as { resource: string; authorization_servers: string[] };
    expect(pr).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] });
    const as = (await (await h.fetch(req("/.well-known/oauth-authorization-server"))).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: PUBLIC, registration_endpoint: `${PUBLIC}/register`, code_challenge_methods_supported: ["S256"] });
  });

  test("register → approve → token → call → refresh → revoke", async () => {
    const h = oauth();
    const { clientId, location } = await registerAndAuthorize(h);
    expect(location.searchParams.get("state")).toBe("s1");
    const code = location.searchParams.get("code")!;
    const form = (p: Record<string, string>) => req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString() });

    expect((await h.fetch(form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: "wrong" }))).status).toBe(400);
    // The failed attempt burned the code; get a fresh one.
    const again = (await registerAndAuthorize(h)).location;
    const second = (await h.fetch(req(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`))).headers.get("location");
    expect(again.searchParams.get("code")).toBeTruthy();
    const code2 = new URL(second!).searchParams.get("code")!;
    const tokens = (await (await h.fetch(form({ grant_type: "authorization_code", code: code2, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }))).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(tokens.access_token).toStartWith("sik_at_");

    const call = (t: string) => h.fetch(new Request(`${PUBLIC}/mcp`, { method: "POST", headers: { host: "sikrets-test.example.com", ...auth(t) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect((await call(tokens.access_token)).status).toBe(200);

    const refreshed = (await (await h.fetch(form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }))).json()) as { access_token: string };
    expect((await call(tokens.access_token)).status).toBe(401); // rotated
    expect((await call(refreshed.access_token)).status).toBe(200);
    // The refresh token was rotated too.
    expect((await h.fetch(form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }))).status).toBe(400);

    const [client] = await store.list();
    expect(client!.name).toMatch(/^chatgpt-[0-9a-f]{12}$/);
    await store.remove(client!.name);
    expect((await call(refreshed.access_token)).status).toBe(401);
  });

  async function tokensFor(h: ReturnType<typeof oauth>) {
    const { clientId } = await registerAndAuthorize(h);
    const location = new URL(
      (await h.fetch(req(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`))).headers.get("location")!,
    );
    const res = await h.fetch(tokenForm({ grant_type: "authorization_code", code: location.searchParams.get("code")!, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }));
    return { clientId, res, tokens: res.status === 200 ? ((await res.json()) as { access_token: string; refresh_token: string }) : undefined };
  }
  const tokenForm = (p: Record<string, string>) => req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString() });

  test("two refreshes with the same token: exactly one wins", async () => {
    const h = oauth();
    const { clientId, tokens } = await tokensFor(h);
    const statuses = await Promise.all([1, 2, 3].map(() => h.fetch(tokenForm({ grant_type: "refresh_token", refresh_token: tokens!.refresh_token, client_id: clientId })).then((r) => r.status)));
    expect(statuses.sort()).toEqual([200, 400, 400]);
  });

  test("a removed client can't refresh its way back", async () => {
    const h = oauth();
    const { clientId, tokens } = await tokensFor(h);
    const [client] = await store.list();
    await store.remove(client!.name);
    // Its registration went with it, so the app is unknown now.
    expect((await h.fetch(tokenForm({ grant_type: "refresh_token", refresh_token: tokens!.refresh_token, client_id: clientId }))).status).toBe(401);
    expect(await store.list()).toEqual([]);
  });

  test("an OAuth app never takes over an existing client's name", async () => {
    const h = oauth();
    const { clientId } = await registerAndAuthorize(h);
    // Someone made a bearer client with exactly the name this app would get.
    const { agentNameFor } = await import("./core/mcp-clients.ts");
    await store.add(agentNameFor("ChatGPT", clientId));
    const location = new URL(
      (await h.fetch(req(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" })}`))).headers.get("location")!,
    );
    const res = await h.fetch(tokenForm({ grant_type: "authorization_code", code: location.searchParams.get("code")!, client_id: clientId, redirect_uri: redirect, code_verifier: verifier }));
    expect(res.status).toBe(500);
    const clients = await store.list();
    expect(clients.map((c) => c.kind)).toEqual(["token"]);
  });

  test("OAuth clients whose refresh token expired are pruned", async () => {
    let t = Date.now();
    const h = handler({ oauth: true, publicUrl: PUBLIC, approveConnect: async () => true, now: () => t });
    await tokensFor(h as ReturnType<typeof oauth>);
    expect(await store.list()).toHaveLength(1);
    t += 31 * 24 * 60 * 60 * 1000;
    const realNow = Date.now;
    Date.now = () => t;
    try {
      await store.add("cursor");
    } finally {
      Date.now = realNow;
    }
    expect((await store.list()).map((c) => c.name)).toEqual(["cursor"]);
  });

  test("a denied approval sends access_denied and issues nothing", async () => {
    const { location } = await registerAndAuthorize(oauth(false));
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test("OAuth endpoints don't exist without --oauth", async () => {
    expect((await handler().fetch(new Request(`${BASE}/register`, { method: "POST", headers: { host: "127.0.0.1:7787" }, body: "{}" }))).status).toBe(404);
  });
});

describe("sikrets mcp --http with the MCP SDK client", () => {
  // Another test file stubs global fetch; this test needs the real network stack.
  beforeEach(() => mock.restore());
  test("a real client connects over HTTP, lists tools and runs a command without seeing the value", async () => {
    const token = (await store.add("sdk-client")).reveal();
    const { url, stop } = serveHttp({ root, allow: [], loadEnv: async () => env, host: "127.0.0.1", port: 0, store, log: () => undefined });
    try {
      const denied = new Client({ name: "no-token", version: "1.0.0" });
      await expect(denied.connect(new StreamableHTTPClientTransport(new URL(url)))).rejects.toThrow();

      const client = new Client({ name: "sdk-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth(token) } }));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_secrets", "run_with_secrets", "recent_activity", "login"]);
      const result = (await client.callTool({ name: "run_with_secrets", arguments: { command: [process.execPath, "-e", "console.log('key=' + process.env.STRIPE_KEY)"] } })) as {
        content: { text: string }[];
      };
      expect(result.content[0]!.text).toContain("key=[secret:STRIPE_KEY]");
      expect(JSON.stringify(result)).not.toContain(KEY);
      await client.close();
    } finally {
      stop();
    }
  });
});

describe("sikrets mcp --http: client lifecycle", () => {
  test("a removal from another process isn't undone by the server's concurrent writes", async () => {
    // Two stores on one file stand in for the server and the `clients rm` CLI: separate queues.
    const other = clientStore({ dir: root, tokens: memoryVault() });
    for (let round = 0; round < 5; round++) {
      await store.add(`c${round}`);
      await Promise.all([store.touch(`c${round}`), other.remove(`c${round}`), store.touch(`c${round}`), store.touch(`c${round}`)]);
      expect((await store.list()).map((c) => c.name)).not.toContain(`c${round}`);
    }
  });

  test("removing a client takes back its login grants; a new client with the same name starts with none", async () => {
    await store.add("cursor");
    const [first] = await store.list();
    await addGrant("github", "https://github.com", clientIdentity(first!));
    await store.remove("cursor");
    expect(await listGrants()).toEqual([]);
    await store.add("cursor");
    const [second] = await store.list();
    expect(clientIdentity(second!).id).not.toBe(clientIdentity(first!).id);
  });

  const pidIn = async (file: string) => {
    for (let i = 0; i < 200 && !(await Bun.file(file).exists()); i++) await Bun.sleep(20);
    return Number((await Bun.file(file).text()).trim());
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const runSleeper = (pids: string) => ({ name: "run_with_secrets", arguments: { command: ["/bin/sh", "-c", `echo $$ > ${pids}; exec sleep 60`] } });

  test("closing the SSE stream stops the running command and writes nothing more", async () => {
    const token = (await store.add("cursor")).reveal();
    const pids = path.join(root, "pids");
    const res = await handler().fetch(rpc("tools/call", runSleeper(pids), { ...auth(token), accept: "application/json, text/event-stream" }));
    const pid = await pidIn(pids);
    expect(alive(pid)).toBe(true);
    await res.body!.cancel();
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
  }, 10_000);

  test("notifications/cancelled over HTTP stops the command it names", async () => {
    const token = (await store.add("cursor")).reveal();
    const h = handler();
    const pids = path.join(root, "pids");
    const call = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", host: "127.0.0.1:7787", ...auth(token) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "run-7", method: "tools/call", params: runSleeper(pids) }),
    });
    const pending = h.fetch(call);
    const pid = await pidIn(pids);
    const cancel = new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:7787", ...auth(token) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "run-7" } }),
    });
    expect((await h.fetch(cancel)).status).toBe(202);
    expect((await pending).status).toBe(202);
    expect(alive(pid)).toBe(false);
  }, 10_000);
});
