import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMANDS, MODEL, OPENCODE, PROXY, SKILLS } from "./constants.ts";
import { createGateway } from "./gateway.ts";
import { start, type Server } from "./opencode.ts";
import { Pool } from "./pool.ts";
import { sha256 } from "./patterns.ts";
import { TOOLS } from "./tools.ts";

// End to end through the gateway and the real opencode binary, with a local stand-in for the model
// that records every request it gets. A fake key pasted in a message must never reach the model,
// the event stream, message reads, or any file opencode writes; the tool must still see the real
// key. Each caller gets its own instance (src/pool.ts); the proxy must answer everything off the allowlist
// without touching opencode. Skills, slash commands and a tiny local MCP server (src/testing/
// mcp-server.ts) must work through the same gateway without loosening any of that.

const FAKE = "sk" + "_live_" + "51Hx9fakeFAKEfake0123456789abcdef";
const CODE = "test-access-code";
const requests: string[] = [];
/** A key the MCP server's config hands it, which nothing else may see. */
const SERVER_TOKEN = "mcp-" + "server-token-0123456789";
/** A key the stub MCP server returns in its own output (src/testing/mcp-server.ts). */
const MCP_KEY = "AKIA" + "Z7QW3RTY5UIOPASD";
/** A key inside a skill file. */
const SKILL_KEY = "ghp_" + "Y7kQ2mN4pR7sT1vX3yB5cD6fG9hJ0kL2mN4q";
/** The key each model request carried. */
const keys: string[] = [];

// An OpenAI-compatible model. Asked to scan a repo, it calls scan_github_repo (which asks for
// permission first); otherwise it calls scan_text with what the user sent. Then it answers.
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const raw = await req.text();
    requests.push(raw);
    keys.push(req.headers.get("authorization") ?? "");
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
    const last = body.messages.at(-1)!;
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "stand-in", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const call = (name: string, args: unknown) => chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }) + chunk({}, "tool_calls");
    const out =
      last.role === "tool" || !(body as { tools?: unknown[] }).tools?.length
        ? chunk({ role: "assistant", content: "Found one Stripe key; rotate it." }) + chunk({}, "stop")
        : text.includes("scan the repo")
          ? call("scan_github_repo", { repo: "octocat/Hello-World" })
          : text.includes("print the environment")
            ? call("shell", { command: "env; cat /proc/$PPID/environ 2>/dev/null | tr '\\0' '\\n'", description: "Print the environment" })
            : text.includes("load the audit skill")
              ? call("skill", { id: "supply-chain-audit" })
              : text.includes("load the browser skill")
                ? call("skill", { id: "browser" })
                : text.includes("echo it")
                  ? call("stub_echo", { text })
                  : text.includes("ask the advisories")
                    ? call("stub_advisory", { name: "left-pad" })
                    : text.includes("list the server env")
                      ? call("stub_env_names", {})
                      : text.includes("use the spare")
                        ? call("spare_echo", { text: "hi" })
                        : call("scan_text", { text });
    return new Response(out + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});

const home = mkdtempSync(path.join(os.tmpdir(), "sikrets-oc-test-"));
/** What the stub MCP servers received, one JSON line per call. */
const mcpLog = path.join(mkdtempSync(path.join(os.tmpdir(), "sikrets-mcp-test-")), "calls.jsonl");
/** The shipped skills, plus one holding a key, to check skill content is redacted. */
const skillsDir = mkdtempSync(path.join(os.tmpdir(), "sikrets-skills-test-"));
const SHIPPED = readdirSync(path.join(import.meta.dir, "..", SKILLS.dir)).sort();
cpSync(path.join(import.meta.dir, "..", SKILLS.dir), skillsDir, { recursive: true });
mkdirSync(path.join(skillsDir, "fixture-skill"));
writeFileSync(path.join(skillsDir, "fixture-skill", SKILLS.file), `---\nname: Fixture\ndescription: A skill for the tests.\n---\nUse the token ${SKILL_KEY} for the demo.\n`);
// Readable (and the log writable) for instances running as their own uids (Linux, as root).
chmodSync(skillsDir, 0o755);
chmodSync(path.dirname(mcpLog), 0o777);
const stub = [process.execPath, path.join(import.meta.dir, "testing", "mcp-server.ts"), mcpLog];
let pool: Pool;
/** The basic-auth caller's own instance. */
const oc = () => pool.running(PROXY.basicOwner)!;
let gateway: ReturnType<typeof createGateway>;
/** Calls the gateway made to opencode, by path. */
const upstream: string[] = [];

const basic = { authorization: `Basic ${Buffer.from(`opencode:${CODE}`).toString("base64")}` };
let cookie = "";

async function call(pathname: string, init: RequestInit = {}, as: Record<string, string> = basic, client = "test-client"): Promise<Response> {
  return gateway.fetch(new Request(`http://gateway${pathname}`, { ...init, headers: { "content-type": "application/json", ...as, ...(init.headers as Record<string, string>) } }), client);
}
/** The gateway allows a client SERVER.perMinute messages a minute; the longer runs below each come from their own. */
let clients = 0;
const fresh = () => `test-client-${++clients}`;

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
  pool = new Pool({
    root: home,
    quiet: true,
    // The stub MCP server runs on Bun and logs to a file outside the instance's home.
    readOnly: [path.dirname(process.execPath)],
    shared: [path.dirname(mcpLog)],
    base: {
      model: { ...MODEL, provider: "standin", id: "stand-in", name: "Stand-in", package: "@opencode/ai/providers/openai-compatible", keyEnv: "STAND_IN_API_KEY", settings: { baseURL: `http://127.0.0.1:${model.port}/v1` } },
      skillsDir,
      mcp: {
        stub: { type: "local", command: stub, environment: { STUB_TOKEN: SERVER_TOKEN }, description: "Stub advisories" },
        spare: { type: "local", command: stub, enabled: false, tools: ["echo"] },
      },
    },
    launch: async (opts) => {
      const real = await start(opts);
      return { ...real, fetch: (p, init) => (upstream.push(p), real.fetch(p, init)) } satisfies Server;
    },
  });
  gateway = createGateway(pool, { accessCode: CODE });
  const login = await call("/api/login", { method: "POST", body: JSON.stringify({ code: CODE }) }, {});
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 60_000);

afterAll(() => {
  gateway?.stop();
  model.stop(true);
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const toolsOf = (request: string) => (JSON.parse(request) as { tools?: Array<{ function: { name: string } }> }).tools?.map((t) => t.function.name).sort() ?? [];
const mcpCalls = () => (existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> }) : []);
const prompt = (session: string, body: Record<string, unknown>, as = basic) => call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify(body) }, as, fresh());
const access = async (on: boolean, as = basic) => expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on }) }, as)).status).toBe(200);

const terminal = (session: string) => (ev: { type: string; data: Record<string, unknown> }) => ev.data?.sessionID === session && /^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type);

describe("the gateway's proxy, end to end", () => {
  let session = "";

  test("a pasted key never leaves the plugin, and the tool still sees it", async () => {
    // A client trying to widen its own powers: permissions, another agent, a host directory.
    const created = await call("/api/session?location%5Bdirectory%5D=%2Fetc", { method: "POST", body: JSON.stringify({ agent: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }], location: { directory: "/etc" } }) });
    session = ((await created.json()) as { data: { id: string; agent: string } }).data.id;
    const info = (await (await call(`/api/session/${session}`)).json()) as { data: { agent: string; location: { directory: string } } };
    expect(info.data.agent).toBe("guard");
    expect(info.data.location.directory).toBe(oc().directory);

    const seen = await events(basic, terminal(session), () =>
      call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: `is this leaked?\nSTRIPE_SECRET_KEY=${FAKE}`, files: [{ uri: "file:///etc/passwd" }] }) }),
    );
    const stream = JSON.stringify(seen);
    expect(seen.at(-1)?.type).toBe("session.execution.succeeded");
    expect(stream).toContain("rotate it");
    expect(stream).not.toContain(FAKE);
    expect(stream).not.toContain("/etc/passwd");

    // The model saw only the placeholder, and only the Sikrets tools, the built-ins, the skill tool
    // and the tools of the MCP server that's on by default (the spare one is off).
    expect(requests.length).toBe(2);
    for (const r of requests) {
      expect(r).not.toContain(FAKE);
      expect(r).toContain("[[secret sk_live_…cdef #");
      expect(toolsOf(r)).toEqual([...Object.keys(TOOLS), ...OPENCODE.builtins, SKILLS.tool, "stub_advisory", "stub_echo", "stub_env_names"].sort());
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

  test("the model never hears the word opencode: not in the system prompt, not in a tool", () => {
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      const body = JSON.parse(r) as { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };
      const system = JSON.stringify(body.messages.filter((m) => m.role === "system"));
      expect(system).toContain("Sikrets security agent");
      expect(system).toContain("Working directory: ");
      expect(system).toContain("Scratch directory: ");
      expect(system).not.toMatch(/open\s?code/i);
      expect(JSON.stringify(body.tools ?? [])).not.toMatch(/open\s?code/i);
    }
  });

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

  test("with full access on, the gateway approves the download and the run finishes unattended", async () => {
    expect(((await (await call("/api/me")).json()) as { fullAccess: boolean }).fullAccess).toBe(false);
    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: "yes" }) })).status).toBe(400);
    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: true }) }, {})).status).toBe(401);
    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: true }) })).status).toBe(200);
    expect(((await (await call("/api/me")).json()) as { fullAccess: boolean }).fullAccess).toBe(true);
    // Another login is unaffected.
    expect(((await (await call("/api/me", {}, { cookie })).json()) as { fullAccess: boolean }).fullAccess).toBe(false);

    const seen = await events(basic, terminal(session), () =>
      call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: "please scan the repo once more" }) }),
    );
    const asked = seen.find((e) => e.type === "permission.asked");
    const replied = seen.find((e) => e.type === "permission.replied");
    expect(asked).toBeDefined();
    expect(replied?.data).toMatchObject({ requestID: asked!.data.id, reply: "always" });
    expect(seen.at(-1)?.type).toMatch(/^session\.execution\./);
    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: false }) })).status).toBe(200);
  }, 60_000);

  test("the model provider gets the real key; opencode and its shell never hold it", async () => {
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(["Bearer not-a-real-key"]));

    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: true }) })).status).toBe(200);
    await events(basic, terminal(session), () => call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: "print the environment" }) }));
    expect((await call("/api/full-access", { method: "PUT", body: JSON.stringify({ on: false }) })).status).toBe(200);
    const output = requests.at(-1)!;
    expect(output).toContain("PATH=");
    expect(output).not.toContain("not-a-real-key");
    expect(output).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(output).not.toContain("OPENCODE_CONFIG_CONTENT");
  }, 60_000);

  test("callers see only their own sessions", async () => {
    const web = { cookie };
    expect((await call(`/api/session/${session}`, {}, web)).status).toBe(404);
    expect((await call(`/api/session/${session}/message`, {}, web)).status).toBe(404);
    expect((await call(`/api/session/${session}/prompt`, { method: "POST", body: JSON.stringify({ text: "hi" }) }, web)).status).toBe(404);
    // The web caller has an instance of its own, in a home of its own.
    expect(pool.running(PROXY.basicOwner)).not.toBe(pool.owners().filter((o) => o !== PROXY.basicOwner).map((o) => pool.running(o))[0]);
    expect(new Set(pool.owners().map((o) => pool.running(o)!.directory)).size).toBe(pool.owners().length);
    // Creating a session with someone else's id yields a session in the caller's own instance:
    // empty, not theirs.
    const claimed = (await (await call("/api/session", { method: "POST", body: JSON.stringify({ id: session }) }, web)).json()) as { data: { id: string } };
    expect(((await (await call(`/api/session/${claimed.data.id}/message`, {}, web)).json()) as { data: unknown[] }).data).toEqual([]);
    expect(((await (await call(`/api/session/${session}/message`)).json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
    await call(`/api/session/${claimed.data.id}`, { method: "DELETE" }, web);
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
      ["GET", "/api/mcp/resource"],
      ["GET", "/api/reference"],
      ["GET", "/api/plugin"],
      ["GET", "/api/integration"],
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
      ["POST", "/api/experimental/mcp/nope/connect"],
      ["PUT", "/api/experimental/mcp/stub"],
      ["DELETE", "/api/experimental/mcp/stub"],
      ["POST", `/api/experimental/session/${session}/skill`],
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

describe("skills, commands and MCP servers, end to end", () => {
  let session = "";
  const asked = (seen: Array<{ type: string; data: Record<string, unknown> }>) => seen.filter((e) => e.type === "permission.asked").map((e) => e.data as { id: string; action: string });

  beforeAll(async () => {
    session = ((await (await call("/api/session", { method: "POST", body: "{}" })).json()) as { data: { id: string } }).data.id;
  });

  test("the lists hold only what the gateway configured", async () => {
    const skills = (await (await call("/api/skill")).json()) as { data: Array<Record<string, unknown>> };
    // Ours only (opencode's built-in skills are about opencode), and no file paths or bodies.
    expect(skills.data.map((s) => s.id).sort()).toEqual([...SHIPPED, "fixture-skill"].sort());
    for (const s of skills.data) expect(Object.keys(s).sort()).toEqual(["description", "id", "name"]);

    const commands = (await (await call("/api/command")).json()) as { data: Array<{ name: string; hint?: string }> };
    expect(commands.data.map((c) => c.name).sort()).toEqual(Object.keys(COMMANDS).sort());
    expect(commands.data.every((c) => c.hint)).toBe(true);

    const mcp = (await (await call("/api/mcp")).json()) as { data: Array<{ name: string; status: { status: string }; enabled: boolean; description?: string }> };
    expect(mcp.data.map((m) => [m.name, m.status.status, m.enabled])).toEqual(expect.arrayContaining([["stub", "connected", true], ["spare", "disabled", false]]));
    expect(mcp.data.find((m) => m.name === "stub")?.description).toBe("Stub advisories");

    // The config read leaves out the servers' environment (and the plugin options that mirror it).
    expect(await (await call("/api/config")).text()).not.toContain(SERVER_TOKEN);

    for (const p of ["/api/skill", "/api/command", "/api/mcp"]) expect((await call(p, {}, {})).status).toBe(401);
    expect((await call("/api/experimental/mcp/spare/connect", { method: "POST", body: "{}" }, {})).status).toBe(401);
  });

  test("a skill picked in the chat is loaded, redacted, and only if it's ours", async () => {
    const before = requests.length;
    const seen = await events(basic, terminal(session), () => prompt(session, { text: "check this $supply-chain-audit $fixture-skill $browser", skills: [{ id: "supply-chain-audit" }, { id: "fixture-skill" }, { id: "browser" }, { id: "opencode" }] }));
    expect(seen.at(-1)?.type).toBe("session.execution.succeeded");
    const sent = requests.slice(before).join("\n");
    expect(sent).toContain('<skill_content name=\\"Supply-chain audit\\">');
    expect(sent).toContain("Never install or build");
    // The fixture skill's key reached the model as a placeholder; opencode's own skills never did.
    expect(sent).toContain('<skill_content name=\\"Fixture\\">');
    expect(sent).toContain("[[secret ghp_…");
    expect(sent).not.toContain(SKILL_KEY);
    expect(sent).not.toContain("Skill: Browser");
    expect(sent).not.toContain("Skill: OpenCode");
    expect(JSON.stringify(seen)).not.toContain(SKILL_KEY);
    expect(await (await call(`/api/session/${session}/message`)).text()).not.toContain(SKILL_KEY);
  }, 60_000);

  test("the model can load our skills itself, and nothing else", async () => {
    let before = requests.length;
    await events(basic, terminal(session), () => prompt(session, { text: "load the audit skill" }));
    expect(requests.slice(before).at(-1)).toContain("Never install or build");
    before = requests.length;
    await events(basic, terminal(session), () => prompt(session, { text: "load the browser skill" }));
    expect(requests.slice(before).at(-1)).not.toContain("In-app browser");
  }, 60_000);

  test("an MCP tool asks first, and the server sees placeholders, never the pasted key", async () => {
    const seen = await events(basic, (ev) => ev.type === "permission.asked", () => prompt(session, { text: `echo it STRIPE_SECRET_KEY=${FAKE}` }));
    const [ask] = asked(seen);
    expect(ask?.action).toBe("stub_echo");
    const done = await events(basic, terminal(session), () => call(`/api/session/${session}/permission/${ask!.id}/reply`, { method: "POST", body: JSON.stringify({ decision: "once" }) }));
    expect(done.at(-1)?.type).toBe("session.execution.succeeded");
    const echo = mcpCalls().filter((c) => c.name === "echo").at(-1)!;
    expect(String(echo.args.text)).toContain("[[secret sk_live_…cdef #");
    expect(JSON.stringify(mcpCalls())).not.toContain(FAKE);
    expect(JSON.stringify([...seen, ...done])).not.toContain(FAKE);
    expect(requests.at(-1)).toContain("echo: ");
  }, 60_000);

  test("full access approves MCP tools too, and what they return is redacted", async () => {
    await access(true);
    const before = requests.length;
    const seen = await events(basic, terminal(session), () => prompt(session, { text: "ask the advisories" }));
    await access(false);
    expect(asked(seen).map((a) => a.action)).toEqual(["stub_advisory"]);
    expect(seen.find((e) => e.type === "permission.replied")?.data).toMatchObject({ reply: "always" });
    expect(seen.at(-1)?.type).toBe("session.execution.succeeded");
    // The server's own key: a placeholder for the model, the event stream and the message store.
    const sent = requests.slice(before).join("\n");
    expect(sent).toContain("No advisories for left-pad");
    expect(sent).toContain("[[secret AKIA");
    expect(sent).not.toContain(MCP_KEY);
    expect(JSON.stringify(seen)).not.toContain(MCP_KEY);
    expect(await (await call(`/api/session/${session}/message`)).text()).not.toContain(MCP_KEY);
  }, 60_000);

  test("MCP servers start with a bare environment", async () => {
    await access(true);
    await events(basic, terminal(session), () => prompt(session, { text: "list the server env" }));
    await access(false);
    const names = (JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }).messages.filter((m) => m.role === "tool").map((m) => String(m.content)).at(-1)!.split("\n");
    expect(names).toEqual(expect.arrayContaining(["PATH", "HOME", "STUB_TOKEN"]));
    for (const n of names) expect(["PATH", "HOME", "STUB_TOKEN", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", "PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]).toContain(n);
    // And the tool output named nothing it shouldn't have (values never leave the server anyway).
    expect(requests.at(-1)).not.toContain("OPENCODE_SERVER_PASSWORD");
    expect(requests.at(-1)).not.toContain("STAND_IN_API_KEY");
    expect(requests.at(-1)).not.toContain(SERVER_TOKEN);
  }, 60_000);

  test("MCP switches are per login, and an off server's tools are gone", async () => {
    const web = { cookie };
    // Off by default: the spare server's tool isn't offered, and calling it fails.
    let before = requests.length;
    let seen = await events(basic, terminal(session), () => prompt(session, { text: "use the spare" }));
    expect(toolsOf(requests[before]!)).not.toContain("spare_echo");
    expect(JSON.stringify(seen)).toMatch(/not available|No tool named|isn't switched on/);

    // This login switches it on (opencode's own connect call); the other login still has it off.
    expect((await call("/api/experimental/mcp/spare/connect", { method: "POST", body: "{}" })).status).toBe(204);
    const mine = (await (await call("/api/mcp")).json()) as { data: Array<{ name: string; enabled: boolean }> };
    const theirs = (await (await call("/api/mcp", {}, web)).json()) as { data: Array<{ name: string; enabled: boolean }> };
    expect(mine.data.find((m) => m.name === "spare")?.enabled).toBe(true);
    expect(theirs.data.find((m) => m.name === "spare")?.enabled).toBe(false);

    before = requests.length;
    seen = await events(basic, (ev) => ev.type === "permission.asked" || terminal(session)(ev), () => prompt(session, { text: "use the spare" }));
    // Only the allowlisted tool of the spare server is offered.
    expect(toolsOf(requests[before]!)).toEqual(expect.arrayContaining(["spare_echo", "stub_echo"]));
    expect(toolsOf(requests[before]!).filter((t) => t.startsWith("spare_"))).toEqual(["spare_echo"]);
    const [ask] = asked(seen);
    expect(ask?.action).toBe("spare_echo");
    await events(basic, terminal(session), () => call(`/api/session/${session}/permission/${ask!.id}/reply`, { method: "POST", body: JSON.stringify({ decision: "reject" }) }));

    // Switching the stub server off takes its tools away from this login's chats.
    expect((await call("/api/experimental/mcp/stub/disconnect", { method: "POST", body: "{}" })).status).toBe(204);
    before = requests.length;
    await events(basic, terminal(session), () => prompt(session, { text: "hello again" }));
    expect(toolsOf(requests[before]!).filter((t) => t.startsWith("stub_"))).toEqual([]);
    expect((await call("/api/experimental/mcp/stub/connect", { method: "POST", body: "{}" })).status).toBe(204);
    expect((await call("/api/experimental/mcp/spare/disconnect", { method: "POST", body: "{}" })).status).toBe(204);
  }, 90_000);

  test("slash commands expand on the server, redacted like any message; unknown ones never reach opencode", async () => {
    const before = requests.length;
    const seen = await events(basic, terminal(session), () => call(`/api/session/${session}/command`, { method: "POST", body: JSON.stringify({ name: "rotate", text: `stripe ${FAKE}` }) }, basic, fresh()));
    expect(seen.at(-1)?.type).toBe("session.execution.succeeded");
    const sent = requests.slice(before).join("\n");
    expect(sent).toContain("How do I rotate a leaked stripe [[secret sk_live_…cdef #");
    expect(sent).not.toContain(FAKE);
    const count = upstream.length;
    for (const name of ["init", "review", "goal", "nope"]) expect((await call(`/api/session/${session}/command`, { method: "POST", body: JSON.stringify({ name }) }, basic, fresh())).status).toBe(404);
    expect(upstream.length).toBe(count);
  }, 60_000);

  test("compaction runs through the gateway", async () => {
    const seen = await events(basic, (ev) => ev.data?.sessionID === session && /compact/.test(ev.type) && /(ended|completed|succeeded|failed)/.test(ev.type), () => call(`/api/session/${session}/compact`, { method: "POST", body: "{}" }, basic, fresh()), 15_000);
    expect(seen.some((e) => /compact/.test(e.type))).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(FAKE);
  }, 30_000);

  test("no key, pasted, in a skill or from an MCP server, is in any file opencode wrote", () => {
    for (const f of files(home)) {
      const b = readFileSync(f);
      for (const k of [FAKE, MCP_KEY, SKILL_KEY]) expect([f, b.includes(k)]).toEqual([f, false]);
    }
  });
});
