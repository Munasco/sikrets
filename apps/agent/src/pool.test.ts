import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { autoApprove, FullAccess } from "./full-access.ts";
import { createGateway } from "./gateway.ts";
import type { Server } from "./opencode.ts";
import { Pool, PoolFull } from "./pool.ts";
import { PROXY } from "./constants.ts";

// The pool's lifecycle with stand-in instances (no opencode): crashes, failed starts, concurrent
// first requests, eviction and the idle sweep racing a restart. And the gateway's login state.

interface Fake extends Server {
  stopped: boolean;
  die(): void;
  /** Sessions with a run going (what /api/session/active answers). */
  active: Record<string, unknown>;
  /** Holds /api/session/active until resolved, to race the sweep. */
  gate?: Promise<void>;
  calls: string[];
  rpc?: (method: string) => unknown;
}

function fake(mcp: Server["capabilities"]["mcp"] = {}): Fake {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((r) => (exit = r));
  const f: Fake = {
    url: "http://fake",
    capabilities: { skills: [], mcp, skillsDir: "" },
    directory: "/fake",
    stopped: false,
    active: {},
    calls: [],
    exited,
    async fetch(p) {
      f.calls.push(p);
      if (p === "/api/session/active") {
        await f.gate;
        return Response.json({ data: f.active });
      }
      const rpc = /^\/api\/rpc\/[^/]+\/([^/]+)$/.exec(p)?.[1];
      if (rpc) return Response.json({ output: f.rpc ? f.rpc(rpc) : { ok: true } });
      return Response.json({ data: [] });
    },
    stop() {
      f.stopped = true;
      exit(0);
    },
    die() {
      exit(1);
    },
  };
  return f;
}

const dirs: string[] = [];
const pools: Pool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { max?: number; mcp?: Server["capabilities"]["mcp"]; make?: () => Fake } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "sikrets-pool-"));
  dirs.push(root);
  const made: Fake[] = [];
  const pool = new Pool({
    root,
    mode: "none",
    quiet: true,
    max: opts.max,
    base: { mcp: opts.mcp ?? {} },
    launch: async () => {
      const f = (opts.make ?? (() => fake(opts.mcp)))();
      made.push(f);
      return f;
    },
  });
  pools.push(pool);
  return { pool, made, root };
}

const tick = () => Bun.sleep(5);

describe("pool", () => {
  test("a crashed instance is dropped, and the next request starts a fresh one", async () => {
    const { pool, made } = setup();
    const a = await pool.acquire("a");
    a.release();
    expect(pool.running("a")).toBe(made[0]);
    made[0]!.die();
    await tick();
    expect(pool.running("a")).toBeUndefined();
    expect(pool.owners()).toEqual([]);
    const b = await pool.acquire("a");
    expect(b.server).toBe(made[1]!);
    b.release();
  });

  test("a start hook that throws undoes the hooks that ran and stops the process", async () => {
    const { pool, made } = setup();
    let undone = 0;
    pool.use(() => () => void undone++);
    pool.use(() => {
      throw new Error("hook failed");
    });
    await expect(pool.acquire("a")).rejects.toThrow("hook failed");
    expect(undone).toBe(1);
    expect(made[0]!.stopped).toBe(true);
    expect(pool.owners()).toEqual([]);
  });

  test("running() is undefined until the start hooks finish", async () => {
    const { pool } = setup();
    let open!: () => void;
    const hooked = new Promise<void>((r) => (open = r));
    pool.use(() => hooked);
    const lease = pool.acquire("a");
    await tick();
    expect(pool.running("a")).toBeUndefined();
    open();
    (await lease).release();
    expect(pool.running("a")).toBeDefined();
  });

  test("two first requests from one owner, with the pool full, start one instance and evict once", async () => {
    const { pool, made } = setup({ max: 2 });
    (await pool.acquire("x")).release();
    (await pool.acquire("y")).release();
    const [one, two] = await Promise.all([pool.acquire("b"), pool.acquire("b")]);
    expect(one.server).toBe(two.server);
    expect(made).toHaveLength(3);
    expect(made.filter((f) => f.stopped)).toHaveLength(1);
    expect(pool.owners().sort()).toEqual(["b", made[0]!.stopped ? "y" : "x"].sort());
  });

  test("eviction skips an instance with a chat running, and refuses when that's all there is", async () => {
    const { pool, made } = setup({ max: 1 });
    (await pool.acquire("a")).release();
    made[0]!.active = { ses_1: {} };
    await expect(pool.acquire("b")).rejects.toBeInstanceOf(PoolFull);
    expect(made[0]!.stopped).toBe(false);
    expect(pool.running("a")).toBe(made[0]);
    made[0]!.active = {};
    (await pool.acquire("b")).release();
    expect(made[0]!.stopped).toBe(true);
  });

  test("the idle sweep never stops an instance that replaced the one it was checking", async () => {
    const { pool, made } = setup();
    (await pool.acquire("a")).release();
    let open!: () => void;
    made[0]!.gate = new Promise<void>((r) => (open = r));
    const sweep = pool.sweep(Date.now() + 365 * 86_400_000);
    await tick();
    // Meanwhile the old instance stops and the owner gets a new one.
    pool.stopOwner("a");
    (await pool.acquire("a")).release();
    open();
    await sweep;
    expect(made[1]!.stopped).toBe(false);
    expect(pool.running("a")).toBe(made[1]);
  });
});

describe("full access", () => {
  test("requests raised while the event stream was down are approved after it reconnects", async () => {
    const access = new FullAccess();
    access.set("o", true);
    const replied: string[] = [];
    let streams = 0;
    let waiting: { id: string; sessionID: string }[] = [];
    const oc = {
      ...fake(),
      async fetch(p: string, init?: RequestInit) {
        if (p === "/api/event") {
          streams++;
          // The first stream ends at once (a dropped connection); the next stays open.
          if (streams === 1) return new Response("", { headers: { "content-type": "text/event-stream" } });
          return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
        }
        if (p === "/api/permission/request") return Response.json({ data: waiting });
        if (p.endsWith("/reply") && init?.method === "POST") replied.push(p);
        return Response.json({});
      },
    } as Server;
    const stop = autoApprove(access).attach("o", oc, 20);
    // Asked while the first stream was down: no event will ever announce it.
    waiting = [{ id: "per_1", sessionID: "ses_1" }];
    await Bun.sleep(80);
    stop();
    expect(streams).toBeGreaterThanOrEqual(2);
    expect(replied.some((p) => p.includes("per_1"))).toBe(true);
  });
});

describe("gateway", () => {
  const CODE = "correct-horse-battery";
  const login = async (gw: ReturnType<typeof createGateway>) => {
    const res = await gw.fetch(new Request("http://x/api/login", { method: "POST", body: JSON.stringify({ code: CODE }) }), "c");
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  const me = async (gw: ReturnType<typeof createGateway>, cookie: string) => ((await (await gw.fetch(new Request("http://x/api/me", { headers: { cookie } }), "c")).json()) as { authed: boolean }).authed;

  test("an empty access code is refused, not treated as no code", () => {
    const { pool } = setup();
    expect(() => createGateway(pool, { accessCode: "  " })).toThrow(/empty/);
    const { root } = setup();
    writeFileSync(path.join(root, "code"), "\n");
    expect(() => createGateway(pool, { accessCodeFile: path.join(root, "code") })).toThrow(/empty/);
  });

  test("logging out revokes that cookie on the server, and stays revoked after a restart", async () => {
    const { pool, root } = setup();
    const revokedFile = path.join(root, "revoked.json");
    const gw = createGateway(pool, { accessCode: CODE, revokedFile });
    const cookie = await login(gw);
    const other = await login(gw);
    expect(await me(gw, cookie)).toBe(true);
    const out = await gw.fetch(new Request("http://x/api/logout", { method: "POST", headers: { cookie } }), "c");
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await me(gw, cookie)).toBe(false);
    expect(await me(gw, other)).toBe(true);
    // A new gateway process reads the revocation back.
    expect(await me(createGateway(pool, { accessCode: CODE, revokedFile }), cookie)).toBe(false);
  });

  test("a rotated code file signs everyone out without a restart, and an emptied one never opens it", async () => {
    const { pool, root } = setup();
    const file = path.join(root, "code");
    writeFileSync(file, CODE);
    const gw = createGateway(pool, { accessCodeFile: file });
    const cookie = await login(gw);
    expect(await me(gw, cookie)).toBe(true);
    await Bun.sleep(10);
    writeFileSync(file, "a-new-code-entirely");
    expect(await me(gw, cookie)).toBe(false);
    writeFileSync(file, "");
    expect(await me(gw, "")).toBe(false);
  });

  test("/healthz reports the enclave's key and certificate state, and fails on an error", async () => {
    const { pool, root } = setup();
    const healthFile = path.join(root, "health.json");
    const gw = createGateway(pool, { healthFile });
    const health = async () => {
      const res = await gw.fetch(new Request("http://x/healthz"), "c");
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await health()).status).toBe(503);
    writeFileSync(healthFile, JSON.stringify({ modelKey: "ok", tls: "ok" }));
    expect(await health()).toEqual({ status: 200, body: { ok: true, modelKey: "ok", tls: "ok" } });
    writeFileSync(healthFile, JSON.stringify({ modelKey: "stale", tls: "ok" }));
    expect((await health()).status).toBe(503);
    writeFileSync(healthFile, JSON.stringify({ modelKey: "ok", tls: "error: RuntimeError: ACME 429" }));
    expect((await health()).status).toBe(503);
  });

  test("an MCP switch the instance didn't take stops the instance instead of leaving it on", async () => {
    const mcp = { docs: { type: "remote", url: "http://127.0.0.1:1/mcp" } } as unknown as Server["capabilities"]["mcp"];
    const { pool, made } = setup({ mcp });
    const gw = createGateway(pool, { accessCode: CODE });
    const auth = { authorization: `Basic ${Buffer.from(`x:${CODE}`).toString("base64")}` };
    expect((await gw.fetch(new Request("http://x/api/session", { headers: auth }), "c")).status).toBe(200);
    expect(pool.running(PROXY.basicOwner)).toBe(made[0]);
    made[0]!.rpc = () => ({ ok: false });
    const res = await gw.fetch(new Request("http://x/api/experimental/mcp/docs/disconnect", { method: "POST", headers: auth, body: "{}" }), "c");
    expect(res.status).toBe(503);
    expect(made[0]!.stopped).toBe(true);
    expect(pool.running(PROXY.basicOwner)).toBeUndefined();
    // The next start gets the saved switch, or fails to start at all.
    made.length = 0;
    expect((await gw.fetch(new Request("http://x/api/session", { headers: auth }), "c")).status).toBe(200);
    const sent = made[0]!.calls.find((c) => c.includes("/api/rpc/"));
    expect(sent).toBeDefined();
  });
});
