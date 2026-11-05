import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL, POOL } from "./constants.ts";
import { createGateway } from "./gateway.ts";
import { Pool } from "./pool.ts";
import { detect } from "./sandbox.ts";

// Two logins, each with their own instance (src/pool.ts). Owner B's agent runs shell commands that
// try to reach owner A's files, sessions and processes; none of it may work. On Linux the
// instances run in namespaces (src/sandbox.ts) and every check runs. macOS has no namespaces, so
// there the instances are only separate processes and directories: the checks that need a sandbox
// are skipped, and the rest (separate instances, homes and session lists) still run.

const CODE = "isolation-code";
/** What A writes into its own working directory. */
const MARKER = "owner-a-private-" + Math.random().toString(36).slice(2);
const requests: string[] = [];

// A stand-in model: "run: <command>" calls the shell with it; a tool result ends the turn.
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const raw = await req.text();
    requests.push(raw);
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };
    const last = body.messages.at(-1)!;
    const text = typeof last.content === "string" ? last.content : Array.isArray(last.content) ? last.content.map((p: { text?: string }) => p.text ?? "").join("") : "";
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "stand-in", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const command = /run: ([\s\S]*)$/.exec(text)?.[1];
    const out =
      last.role === "tool" || !command || !body.tools?.length
        ? chunk({ role: "assistant", content: "Done." }) + chunk({}, "stop")
        : chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command, description: "Run a command" }) } }] }) + chunk({}, "tool_calls");
    return new Response(out + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});

const root = mkdtempSync(path.join(os.tmpdir(), "sikrets-iso-test-"));
let pool: Pool;
let gateway: ReturnType<typeof createGateway>;
const as = { a: "", b: "" };
const owner = { a: "", b: "" };
const session = { a: "", b: "" };
let client = 0;

const call = (pathname: string, init: RequestInit = {}, cookie = "") =>
  gateway.fetch(new Request(`http://gateway${pathname}`, { ...init, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } }), `iso-${++client}`);

/** Logs in; returns the cookie. */
async function login() {
  const res = await call("/api/login", { method: "POST", body: JSON.stringify({ code: CODE }) });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** Runs a shell command as the agent in this login's session; returns what the shell printed. */
async function run(who: "a" | "b", command: string): Promise<string> {
  const before = requests.length;
  const ctrl = new AbortController();
  const events = await call("/api/event", { signal: ctrl.signal }, as[who]);
  const reader = events.body!.getReader();
  await call(`/api/session/${session[who]}/prompt`, { method: "POST", body: JSON.stringify({ text: `run: ${command}` }) }, as[who]);
  const dec = new TextDecoder();
  let raw = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    raw += dec.decode(value, { stream: true });
    if (/session\.execution\.(succeeded|failed|interrupted)/.test(raw)) break;
  }
  ctrl.abort();
  const sent = requests.slice(before).map((r) => JSON.parse(r) as { messages: Array<{ role: string; content: unknown }> });
  const tool = sent.flatMap((r) => r.messages.filter((m) => m.role === "tool")).at(-1);
  return typeof tool?.content === "string" ? tool.content : JSON.stringify(tool?.content ?? "");
}

beforeAll(async () => {
  process.env.STAND_IN_API_KEY = "not-a-real-key";
  pool = new Pool({
    root,
    quiet: true,
    base: { model: { ...MODEL, provider: "standin", id: "stand-in", name: "Stand-in", package: "@opencode/ai/providers/openai-compatible", keyEnv: "STAND_IN_API_KEY", settings: { baseURL: `http://127.0.0.1:${model.port}/v1` } }, mcp: {} },
  });
  gateway = createGateway(pool, { accessCode: CODE });
  for (const who of ["a", "b"] as const) {
    as[who] = await login();
    const before = new Set(pool.owners());
    session[who] = ((await (await call("/api/session", { method: "POST", body: "{}" }, as[who])).json()) as { data: { id: string } }).data.id;
    owner[who] = pool.owners().find((o) => !before.has(o))!;
    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: true }) }, as[who])).status).toBe(200);
  }
  await run("a", `printf %s ${MARKER} > marker.txt && cat marker.txt`);
}, 120_000);

afterAll(() => {
  gateway?.stop();
  model.stop(true);
});

const sandboxed = () => pool.mode === "bwrap" || pool.mode === "bwrap-user";
/** Why the sandbox checks can't run here, if they can't. */
const found = detect();
const off = found.mode === "none" ? ` (skipped: ${found.why}; instances are only separate processes and directories)` : "";

describe("each owner's instance is their own", () => {
  test("each owner has their own instance and home, and the agent works in it", async () => {
    expect(owner.a).toBeTruthy();
    expect(owner.b).toBeTruthy();
    const [a, b] = [pool.running(owner.a)!, pool.running(owner.b)!];
    expect(a.url).not.toBe(b.url);
    expect(a.directory.startsWith(pool.home(owner.a))).toBe(true);
    expect(b.directory.startsWith(pool.home(owner.b))).toBe(true);
    expect(await run("a", "cat marker.txt")).toContain(MARKER);
    expect(await run("b", "pwd")).toContain(b.directory);
  }, 60_000);

  test("B's API sees none of A's sessions", async () => {
    expect((await call(`/api/session/${session.a}`, {}, as.b)).status).toBe(404);
    expect((await call(`/api/session/${session.a}/message`, {}, as.b)).status).toBe(404);
    const list = (await (await call("/api/session", {}, as.b)).json()) as { data: Array<{ id: string }> };
    expect(list.data.map((s) => s.id)).not.toContain(session.a);
  });

  test.skipIf(Boolean(off))(`B's shell can't list or read A's files${off}`, async () => {
    const home = pool.home(owner.a);
    const out = await run("b", `ls -la ${home} 2>&1; cat ${home}/work/marker.txt 2>&1; grep -rs ${MARKER} ${path.dirname(home)} /tmp 2>&1 | head -5; echo end`);
    expect(out).toContain("end");
    expect(out).not.toContain(MARKER);
    expect(out).toMatch(/No such file|Permission denied/);
  }, 60_000);

  test.skipIf(Boolean(off))(`B's shell can't see A's processes or their environment${off}`, async () => {
    const home = pool.home(owner.a);
    // The name is split in the command and grep reads it from a file (printf is a builtin), so no
    // command line of the check itself holds it.
    const id = path.basename(home);
    const out = await run("b", `H=${id.slice(0, 8)}; T=${id.slice(8)}; printf %s "$H$T" > pattern; for p in /proc/[0-9]*; do cat $p/environ $p/cmdline 2>/dev/null; done | tr '\\0' '\\n' | grep -F -f pattern | head -3; echo end`);
    expect(out).toContain("end");
    // Nothing that names A's home, in any process's command line or environment B can read.
    expect(out).not.toContain(id);
    if (sandboxed()) {
      // Its own pid namespace: a handful of processes, its own.
      const pids = await run("b", "ls -d /proc/[0-9]* | wc -l");
      expect(Number(pids.trim().split(/\s+/)[0])).toBeLessThan(40);
    }
  }, 60_000);

  test.skipIf(found.mode !== "bwrap" && found.mode !== "uid")(`owners run as different users${found.mode !== "bwrap" && found.mode !== "uid" ? ` (skipped: the gateway can't give each owner a uid here, sandbox mode "${found.mode}")` : ""}`, async () => {
    const [a, b] = [await run("a", "id -u"), await run("b", "id -u")];
    expect(Number(a.trim())).toBeGreaterThanOrEqual(POOL.uidBase);
    expect(Number(b.trim())).toBeGreaterThanOrEqual(POOL.uidBase);
    expect(a.trim()).not.toBe(b.trim());
  }, 60_000);

  test("an idle instance is stopped, and comes back on the next request", async () => {
    const before = pool.running(owner.b)!;
    await pool.sweep(Date.now() + POOL.idleMs + 1);
    expect(pool.running(owner.b)).toBeUndefined();
    expect((await call("/api/session", {}, as.b)).status).toBe(200);
    expect(pool.running(owner.b)).toBeDefined();
    expect(pool.running(owner.b)).not.toBe(before);
    // Its sessions are still there: they live in the owner's home.
    const list = (await (await call("/api/session", {}, as.b)).json()) as { data: Array<{ id: string }> };
    expect(list.data.map((s) => s.id)).toContain(session.b);
  }, 60_000);
});
