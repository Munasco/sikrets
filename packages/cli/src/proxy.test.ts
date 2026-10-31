import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { makeSessionCerts, type SessionCerts } from "./core/proxy/certs.ts";
import { sandboxed, seatbeltProfile } from "./core/proxy/sandbox.ts";
import { startProxy, type Proxy, type RequestLog } from "./core/proxy/server.ts";
import { Secret } from "./core/secret.ts";
import { SERVICES } from "./core/proxy/services.ts";

// Real CONNECT and TLS from curl, against a fake provider that records what it was sent.
const REAL = { github: "real-github-token-0123456789", slack: "real-slack-token-0123456789" };
const seen: { host: string; auth: string | null; method: string }[] = [];
const provider = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    seen.push({ host: req.headers.get("x-forwarded-host") ?? "", auth: req.headers.get("authorization"), method: req.method });
    return Response.json({ ok: true });
  },
});

let certs: SessionCerts;
let proxy: Proxy;
const logs: RequestLog[] = [];
beforeAll(async () => {
  mock.restore(); // other test files mock fetch and the keychain; this one needs the real ones
  certs = await makeSessionCerts(["api.github.com", "uploads.github.com", "github.com", "slack.com"]);
  proxy = await startProxy({
    certs,
    tokens: new Map([["github", Secret.of(REAL.github)], ["slack", Secret.of(REAL.slack)]]),
    upstream: () => `http://127.0.0.1:${provider.port}`,
    log: (e) => logs.push(e),
  });
});
afterAll(async () => {
  await proxy.stop();
  await certs.dispose();
  provider.stop(true);
});

async function curl(url: string, token: string, ...extra: string[]) {
  const p = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", certs.bundleFile, "-x", `http://${token}:@127.0.0.1:${proxy.port}`, ...extra, url], { stdout: "pipe", stderr: "pipe" });
  return Number(await new Response(p.stdout).text());
}

describe("credential proxy", () => {
  test("the agent's session token becomes the real token, and the agent's own header is dropped", async () => {
    const s = proxy.open("t", [{ service: "github" }], 60_000);
    seen.length = 0;
    expect(await curl("https://api.github.com/user", s.token, "-H", "authorization: Bearer agent-supplied")).toBe(200);
    expect(seen[0]!.auth).toBe(`Bearer ${REAL.github}`);
    // git over HTTPS gets Basic auth with the token as the password.
    expect(await curl("https://github.com/acme/repo.git/info/refs", s.token)).toBe(200);
    expect(Buffer.from(seen[1]!.auth!.slice(6), "base64").toString()).toBe(`x-access-token:${REAL.github}`);
  });

  test("no session, a guessed one, an expired one and a revoked one all get nothing", async () => {
    expect(await curl("https://api.github.com/user", "")).toBe(0); // curl reports the 407 CONNECT as 000
    expect(await curl("https://api.github.com/user", "sks_guessed")).toBe(0);
    const short = proxy.open("t", [{ service: "github" }], 50);
    await Bun.sleep(80);
    expect(await curl("https://api.github.com/user", short.token)).toBe(0);
    const s = proxy.open("t", [{ service: "github" }], 60_000);
    expect(await curl("https://api.github.com/user", s.token)).toBe(200);
    proxy.revoke(s.token);
    expect(await curl("https://api.github.com/user", s.token)).toBe(0);
  });

  test("a session only reaches its own services, with its own methods", async () => {
    const s = proxy.open("t", [{ service: "slack", methods: ["GET"] }], 60_000);
    seen.length = 0;
    expect(await curl("https://slack.com/api/auth.test", s.token)).toBe(200);
    expect(seen[0]!.auth).toBe(`Bearer ${REAL.slack}`);
    expect(await curl("https://slack.com/api/chat.postMessage", s.token, "-X", "POST")).toBe(403);
    // GitHub isn't in this bundle: its traffic is tunnelled untouched, so no token is attached.
    expect(logs.at(-1)!.denied).toContain("POST isn't allowed");
  });

  test("--only-services refuses every other host", async () => {
    const strict = await startProxy({ certs, tokens: new Map([["github", Secret.of(REAL.github)]]), onlyServices: true, upstream: () => `http://127.0.0.1:${provider.port}` });
    const s = strict.open("t", [{ service: "github" }], 60_000);
    const p = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-p", "-x", `http://${s.token}:@127.0.0.1:${strict.port}`, `http://127.0.0.1:${provider.port}/`], { stdout: "pipe" });
    expect(Number(await new Response(p.stdout).text())).toBe(0); // 403 to the CONNECT
    await strict.stop();
  });

  test("other hosts are tunnelled without the proxy seeing inside", async () => {
    const s = proxy.open("t", [{ service: "github" }], 60_000);
    seen.length = 0;
    const p = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-p", "-x", `http://${s.token}:@127.0.0.1:${proxy.port}`, `http://127.0.0.1:${provider.port}/x`], { stdout: "pipe" });
    expect(Number(await new Response(p.stdout).text())).toBe(200);
    expect(seen[0]!.auth).toBeNull();
  });
});

describe("catalog services", () => {
  test("keys go where each service expects them: a custom header or a query parameter", async () => {
    const pick = (f: (c: ReturnType<(typeof SERVICES)[number]["hosts"][string]>) => boolean) =>
      SERVICES.find((s) => !["github", "slack", "anthropic", "openai", "resend", "stripe"].includes(s.id) && f(Object.values(s.hosts)[0]!("k")))!;
    const header = pick((c) => !!c.headers && !("authorization" in c.headers));
    const query = pick((c) => !!c.query);
    const hosts = [Object.keys(header.hosts)[0]!, Object.keys(query.hosts)[0]!];
    const got: { url: string; headers: Record<string, string> }[] = [];
    const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (got.push({ url: req.url, headers: Object.fromEntries(req.headers) }), Response.json({})) });
    const c = await makeSessionCerts(hosts);
    const p = await startProxy({ certs: c, tokens: new Map([[header.id, Secret.of("real-header-key")], [query.id, Secret.of("real-query-key")]]), upstream: () => `http://127.0.0.1:${fake.port}` });
    const s = p.open("t", [{ service: header.id }, { service: query.id }], 60_000);
    const run = async (url: string) => {
      const x = Bun.spawn(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", c.bundleFile, "-x", `http://sikrets:${s.token}@127.0.0.1:${p.port}`, url], { stdout: "pipe" });
      return Number(await new Response(x.stdout).text());
    };
    const headerName = Object.keys(Object.values(header.hosts)[0]!("k").headers!)[0]!;
    const queryName = Object.keys(Object.values(query.hosts)[0]!("k").query!)[0]!;
    expect(await run(`https://${hosts[0]}/v1/x`)).toBe(200);
    expect(got[0]!.headers[headerName]).toBe("real-header-key");
    expect(await run(`https://${hosts[1]}/v1/y?${queryName}=${s.token}&q=1`)).toBe(200);
    const u = new URL(got[1]!.url);
    expect(u.searchParams.get(queryName)).toBe("real-query-key");
    expect(u.searchParams.get("q")).toBe("1");
    await p.stop();
    await c.dispose();
    fake.stop(true);
  });
});

describe.if(process.platform === "darwin")("sandbox", () => {
  test("the agent can use the proxy but not the keychain or the network directly", async () => {
    await Bun.secrets.set({ service: "dev.sikrets.test.sandbox", name: "T", value: "should-stay-hidden" });
    const s = proxy.open("t", [{ service: "github" }], 60_000);
    const profile = seatbeltProfile({ privateDirs: [certs.dir] });
    // Async: the proxy runs in this process, so a blocking spawn would deadlock it.
    const run = async (...cmd: string[]) => {
      const p = Bun.spawn(sandboxed(cmd, profile), { stdout: "pipe", stderr: "pipe" });
      return { stdout: await new Response(p.stdout).text(), exitCode: await p.exited };
    };
    const via = await run("curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", certs.bundleFile, "-x", `http://${s.token}:@127.0.0.1:${proxy.port}`, "https://api.github.com/user");
    expect(via.stdout).toBe("200");
    const direct = await run("curl", "-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com");
    expect(direct.stdout).toBe("000");
    const keychain = await run("security", "find-generic-password", "-s", "dev.sikrets.test.sandbox", "-a", "T", "-w");
    expect(keychain.stdout).not.toContain("should-stay-hidden");
    const keys = await run("ls", certs.dir);
    expect(keys.exitCode).not.toBe(0);
    await Bun.secrets.delete({ service: "dev.sikrets.test.sandbox", name: "T" });
  }, 20_000);
});
