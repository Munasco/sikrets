import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chat, createSession } from "./chat.ts";
import { MODEL } from "./constants.ts";
import { start, type Server } from "./opencode.ts";
import { sha256 } from "./patterns.ts";
import { TOOLS } from "./tools.ts";

// End to end through the real opencode binary, with a local stand-in for the model that records
// every request it gets. A fake key pasted in a message must never reach the model, the event
// stream, the stored session, or any file opencode writes; the tool must still see the real key.

const FAKE = "sk" + "_live_" + "51Hx9fakeFAKEfake0123456789abcdef";
const requests: string[] = [];

// An OpenAI-compatible model: first it calls scan_text with what the user sent, then it answers.
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const raw = await req.text();
    requests.push(raw);
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
    const last = body.messages.at(-1)!;
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "stand-in", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const out =
      last.role === "tool"
        ? chunk({ role: "assistant", content: "Found one Stripe key; rotate it." }) + chunk({}, "stop")
        : chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "scan_text", arguments: JSON.stringify({ text: typeof last.content === "string" ? last.content : JSON.stringify(last.content) }) } }] }) + chunk({}, "tool_calls");
    return new Response(out + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});

const home = mkdtempSync(path.join(os.tmpdir(), "sikrets-oc-test-"));
let oc: Server;

beforeAll(async () => {
  process.env.STAND_IN_API_KEY = "not-a-real-key";
  oc = await start({
    home,
    port: 4197,
    model: { ...MODEL, provider: "standin", id: "stand-in", name: "Stand-in", package: "@opencode/ai/providers/openai-compatible", keyEnv: "STAND_IN_API_KEY", settings: { baseURL: `http://127.0.0.1:${model.port}/v1` } },
  });
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

describe("redaction through opencode", () => {
  test("a pasted key never leaves the plugin, and the tool still sees it", async () => {
    const session = await createSession(oc);
    const events = [];
    for await (const ev of chat(oc, session, `is this leaked?\nSTRIPE_SECRET_KEY=${FAKE}`, new AbortController().signal)) events.push(ev);
    const stream = JSON.stringify(events);

    // The page is told one key was hidden, and the run finished with the tool's answer.
    expect(events[0]).toMatchObject({ type: "hidden", count: 1 });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(stream).toContain("rotate it");

    // The model saw only the placeholder, and only the five Sikrets tools.
    expect(requests.length).toBe(2);
    for (const r of requests) {
      expect(r).not.toContain(FAKE);
      expect(r).toContain("[[secret sk_live_…cdef #");
      const tools = (JSON.parse(r) as { tools?: Array<{ function: { name: string } }> }).tools?.map((t) => t.function.name).sort();
      expect(tools).toEqual(Object.keys(TOOLS).sort());
    }

    // The tool got the real key back: its finding's hash is the real key's hash.
    const result = events.find((e) => e.type === "tool_result") as { result: { findings: Array<{ sha256: string }> } };
    expect(result.result.findings[0]!.sha256).toBe(sha256(FAKE));
    expect(stream).not.toContain(FAKE);

    // Nothing opencode stored or logged holds the key; the stored message has the placeholder.
    const stored = await (await oc.fetch(`/api/session/${session}/message`)).text();
    expect(stored).not.toContain(FAKE);
    expect(stored).toContain("[[secret sk_live_…cdef #");
    for (const f of files(home)) expect(readFileSync(f).includes(FAKE)).toBe(false);
  }, 60_000);

  test("the guard agent is the only agent, with every built-in tool denied", async () => {
    const agents = ((await (await oc.fetch("/api/agent")).json()) as { data: Array<{ id: string; mode: string; hidden?: boolean }> }).data;
    expect(agents.filter((a) => !a.hidden && a.mode !== "subagent").map((a) => a.id)).toEqual(["guard"]);
  });
});
