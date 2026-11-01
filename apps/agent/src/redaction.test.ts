import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL } from "./constants.ts";
import { createGateway } from "./gateway.ts";
import { start, type Server } from "./opencode.ts";
import { sha256 } from "./patterns.ts";
import { TOOLS } from "./tools.ts";

// End to end through the gateway and the real opencode binary, with a local stand-in for the model
// that records every request it gets. A fake key pasted in a message must never reach the model,
// the event stream, message reads, or any file opencode writes; the tool must still see the real
// key. The proxy must keep callers to their own sessions and answer everything off the allowlist
// without touching opencode.

const FAKE = "sk" + "_live_" + "51Hx9fakeFAKEfake0123456789abcdef";
const CODE = "test-access-code";
const requests: string[] = [];

// An OpenAI-compatible model. Asked to scan a repo, it calls scan_github_repo (which asks for
// permission first); otherwise it calls scan_text with what the user sent. Then it answers.
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const raw = await req.text();
    requests.push(raw);
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
    const last = body.messages.at(-1)!;
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "stand-in", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const call = (name: string, args: unknown) => chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }) + chunk({}, "tool_calls");
    const out =
      last.role === "tool"
        ? chunk({ role: "assistant", content: "Found one Stripe key; rotate it." }) + chunk({}, "stop")
        : text.includes("scan the repo")
          ? call("scan_github_repo", { repo: "octocat/Hello-World" })
          : call("scan_text", { text });
    return new Response(out + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});

const home = mkdtempSync(path.join(os.tmpdir(), "sikrets-oc-test-"));
let oc: Server;
let gateway: ReturnType<typeof createGateway>;
/** Calls the gateway made to opencode, by path. */
const upstream: string[] = [];

const basic = { authorization: `Basic ${Buffer.from(`opencode:${CODE}`).toString("base64")}` };
let cookie = "";

async function call(pathname: string, init: RequestInit = {}, as: Record<string, string> = basic): Promise<Response> {
  return gateway.fetch(new Request(`http://gateway${pathname}`, { ...init, headers: { "content-type": "application/json", ...as, ...(init.headers as Record<string, string>) } }), "test-client");
}

/** Reads the gateway's event stream until `until` matches an event, or the time runs out. */
async function events(as: Record<string, string>, until: (ev: { type: string; data: Record<string, unknown> }) => boolean, act: () => Promise<unknown>, ms = 30_000) {
  const ctrl = new AbortController();
  const res = await call("/api/event", { signal: ctrl.signal }, as);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = "";
  const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
  await act();
  const deadline = Date.now() + ms;
  outer: while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    raw += dec.decode(value, { stream: true });
    let i;
    while ((i = raw.indexOf("\n\n")) >= 0) {
      const block = raw.slice(0, i);
      raw = raw.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
      if (!data) continue;
      const ev = JSON.parse(data);
      seen.push(ev);
      if (until(ev)) break outer;
    }
  }
  ctrl.abort();
  return seen;
}

beforeAll(async () => {
  process.env.STAND_IN_API_KEY = "not-a-real-key";
  const real = await start({
    home,
    port: 4197,
    model: { ...MODEL, provider: "standin", id: "stand-in", name: "Stand-in", package: "@opencode/ai/providers/openai-compatible", keyEnv: "STAND_IN_API_KEY", settings: { baseURL: `http://127.0.0.1:${model.port}/v1` } },
  });
  oc = { ...real, fetch: (p, init) => (upstream.push(p), real.fetch(p, init)) };
  gateway = createGateway(oc, { accessCode: CODE });
  const login = await call("/api/login", { method: "POST", body: JSON.stringify({ code: CODE }) }, {});
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 60_000);

afterAll(() => {
  oc?.stop();
  model.stop(true);
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const terminal = (session: string) => (ev: { type: string; data: Record<string, unknown> }) => ev.data?.sessionID === session && /^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type);

describe("the gateway's proxy, end to end", () => {
  let session = "";

  test("a pasted key never leaves the plugin, and the tool still sees it", async () => {
    // A client trying to widen its own powers: permissions, another agent, a host directory.
    const created = await call("/api/session?location%5Bdirectory%5D=%2Fetc", { method: "POST", body: JSON.stringify({ agent: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }], location: { directory: "/etc" } }) });
    session = ((await created.json()) as { data: { id: string; agent: string } }).data.id;
    const info = (await (await call(`/api/session/${session}`)).json()) as { data: { agent: string; location: { directory: string } } };
    expect(info.data.agent).toBe("guard");
    expect(info.data.location.directory).toBe(oc.directory);

    const seen = await events(basic, terminal(session), () =>
      call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: `is this leaked?\nSTRIPE_SECRET_KEY=${FAKE}`, files: [{ uri: "file:///etc/passwd" }] }) }),
    );
    const stream = JSON.stringify(seen);
    expect(seen.at(-1)?.type).toBe("session.execution.succeeded");
    expect(stream).toContain("rotate it");
    expect(stream).not.toContain(FAKE);
    expect(stream).not.toContain("/etc/passwd");

    // The model saw only the placeholder, and only the five Sikrets tools.
    expect(requests.length).toBe(2);
    for (const r of requests) {
      expect(r).not.toContain(FAKE);
      expect(r).toContain("[[secret sk_live_…cdef #");
      const tools = (JSON.parse(r) as { tools?: Array<{ function: { name: string } }> }).tools?.map((t) => t.function.name).sort();
      expect(tools).toEqual(Object.keys(TOOLS).sort());
    }

    // The tool got the real key back: its finding's hash is the real key's hash.
    const success = seen.find((e) => e.type === "session.tool.success") as unknown as { data: { content: Array<{ text: string }> } };
    expect(JSON.parse(success.data.content[0]!.text).findings[0].sha256).toBe(sha256(FAKE));

    // Message reads, and every file opencode wrote, hold the placeholder at most.
    const stored = await (await call(`/api/session/${session}/message`)).text();
    expect(stored).not.toContain(FAKE);
    expect(stored).toContain("[[secret sk_live_…cdef #");
    for (const f of files(home)) expect(readFileSync(f).includes(FAKE)).toBe(false);
  }, 60_000);

  test("a repo download waits for permission, and the reply goes through", async () => {
    const seen = await events(basic, (ev) => ev.type === "permission.asked" || terminal(session)(ev), () =>
      call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: "please scan the repo" }) }),
    );
    const asked = seen.find((e) => e.type === "permission.asked") as unknown as { data: { id: string; action: string; resources: string[] } };
    expect(asked.data).toMatchObject({ action: "scan_github_repo", resources: ["octocat/Hello-World"] });
    const pending = (await (await call(`/api/session/${session}/permission`)).json()) as { data: Array<{ id: string }> };
    expect(pending.data.map((p) => p.id)).toContain(asked.data.id);
    const done = await events(basic, terminal(session), () =>
      call(`/api/session/${session}/permission/${asked.data.id}/reply`, { method: "POST", body: JSON.stringify({ decision: "reject" }) }),
    );
    expect(done.at(-1)?.type).toMatch(/^session\.execution\./);
  }, 60_000);

  test("callers see only their own sessions", async () => {
    const web = { cookie };
    expect((await call(`/api/session/${session}`, {}, web)).status).toBe(404);
    expect((await call(`/api/session/${session}/message`, {}, web)).status).toBe(404);
    expect((await call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: "hi" }) }, web)).status).toBe(404);
    // Creating a session with someone else's id yields a new session, not theirs.
    const claimed = (await (await call("/api/session", { method: "POST", body: JSON.stringify({ id: session }) }, web)).json()) as { data: { id: string } };
    expect(claimed.data.id).not.toBe(session);
    const list = (await (await call("/api/session", {}, web)).json()) as { data: Array<{ id: string }> };
    expect(list.data.map((s) => s.id)).not.toContain(session);
    expect(((await (await call("/api/session")).json()) as { data: Array<{ id: string }> }).data.map((s) => s.id)).toContain(session);

    // The web caller's event stream carries nothing about the other caller's session.
    const theirs = await events(web, () => false, () => call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: "again" }) }), 4_000);
    expect(JSON.stringify(theirs)).not.toContain(session);
  }, 60_000);

  test("no access code, no API", async () => {
    expect((await call("/api/session", {}, {})).status).toBe(401);
    expect((await call("/api/session", {}, { authorization: `Basic ${Buffer.from("opencode:wrong").toString("base64")}` })).status).toBe(401);
  });

  test("stubbed and unknown paths answer without touching opencode", async () => {
    const before = upstream.length;
    const stubbed: Array<[string, string]> = [
      ["GET", "/api/fs/list"],
      ["GET", "/api/fs/find?query=passwd"],
      ["GET", "/api/vcs"],
      ["GET", "/api/shell"],
      ["GET", "/api/config/shell"],
      ["GET", "/api/worktree?projectID=x"],
      ["POST", "/api/worktree/refresh"],
      ["GET", "/api/mcp"],
      ["GET", "/api/mcp/resource"],
      ["GET", "/api/reference"],
      ["GET", "/api/plugin"],
      ["GET", "/api/integration"],
      ["GET", "/api/skill"],
      ["GET", "/api/command"],
      ["GET", "/api/permission/saved"],
      ["GET", `/api/experimental/session/${session}/terminal`],
      ["POST", "/api/rpc/opencode.goal/get"],
    ];
    for (const [method, p] of stubbed) {
      const res = await call(p, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status).toBeLessThan(300);
      // Empty answers: at most opencode's own working directory, never a listing.
      const text = await res.text();
      if (text) expect(JSON.stringify(JSON.parse(text))).not.toMatch(/"data":\[[^\]]|"resources":\[[^\]]/);
    }
    const denied: Array<[string, string]> = [
      ["GET", "/api/fs/read?path=/etc/passwd"],
      ["POST", `/api/session/${session}/shell`],
      ["POST", `/api/session/${session}/command`],
      ["POST", `/api/session/${session}/fork`],
      ["POST", `/api/session/${session}/permission`],
      ["GET", `/api/experimental/session/${session}/export`],
      ["GET", `/api/experimental/session/${session}/log`],
      ["PATCH", "/api/config"],
      ["POST", "/api/mcp"],
      ["POST", "/api/worktree"],
      ["POST", "/api/pty"],
      ["POST", "/api/pair"],
      ["POST", "/api/location/reload"],
      ["GET", "/api/credential"],
      ["POST", "/api/integration/openai/connect/key"],
      ["DELETE", "/api/permission/saved/x"],
      ["GET", "/api/nope"],
    ];
    for (const [method, p] of denied) {
      const res = await call(p, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      expect([p, res.status]).toEqual([p, 404]);
    }
    expect(upstream.slice(before)).toEqual([]);
  });
});
