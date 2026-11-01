import { MODEL, OPENCODE } from "./constants.ts";
import { shield } from "./redact.ts";
import type { Server } from "./opencode.ts";

// One chat turn through opencode: send the message to the session, then turn opencode's event
// stream for that session into the small set of events the page renders. The plugin inside
// opencode does the redaction; the count and redacted text here only tell the page what happened.

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning" }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; ms: number }
  | { type: "hidden"; count: number; text: string }
  | { type: "done"; model: string }
  | { type: "error"; message: string };

interface OpencodeEvent {
  type: string;
  data: { sessionID?: string; id?: string; name?: string; input?: unknown; delta?: string; content?: Array<{ type: string; text?: string }>; error?: { message?: string } };
}

export async function createSession(oc: Server): Promise<string> {
  const res = await oc.fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: OPENCODE.agent }) });
  if (!res.ok) throw new Error(`Couldn't start a session (${res.status}).`);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

export async function removeSession(oc: Server, session: string) {
  await oc.fetch(`/api/session/${encodeURIComponent(session)}`, { method: "DELETE" }).catch(() => {});
}

/** Server-sent events from opencode, parsed. */
async function* events(res: Response): AsyncGenerator<OpencodeEvent> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (data) yield JSON.parse(data) as OpencodeEvent;
    }
  }
}

function parse(content: OpencodeEvent["data"]["content"]): unknown {
  const text = content?.map((c) => c.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function* chat(oc: Server, session: string, text: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const preview = shield(text);
  if (preview.secrets.size) yield { type: "hidden", count: preview.secrets.size, text: preview.text };

  // Subscribe before sending so no event is missed.
  const stream = new AbortController();
  const stop = () => stream.abort();
  signal.addEventListener("abort", stop);
  const sub = await oc.fetch("/api/event", { signal: stream.signal });
  try {
    const sent = await oc.fetch(`/api/session/${encodeURIComponent(session)}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!sent.ok) {
      yield { type: "error", message: `The agent didn't accept the message (${sent.status}).` };
      return;
    }
    const names = new Map<string, string>();
    const started = new Map<string, number>();
    for await (const ev of events(sub)) {
      const d = ev.data ?? {};
      if (d.sessionID !== session) continue;
      if (ev.type === "session.text.delta" && d.delta) yield { type: "text", delta: d.delta };
      else if (ev.type === "session.reasoning.delta") yield { type: "reasoning" };
      else if (ev.type === "session.tool.input.started") names.set(d.id!, d.name!);
      else if (ev.type === "session.tool.called") {
        started.set(d.id!, performance.now());
        yield { type: "tool", id: d.id!, name: names.get(d.id!) ?? "tool", input: d.input };
      } else if (ev.type === "session.tool.success" || ev.type === "session.tool.failed") {
        const result = ev.type === "session.tool.success" ? parse(d.content) : { error: d.error?.message ?? "The tool failed." };
        yield { type: "tool_result", id: d.id!, name: names.get(d.id!) ?? "tool", result, ms: Math.round(performance.now() - (started.get(d.id!) ?? performance.now())) };
      } else if (ev.type === "session.step.failed" || ev.type === "session.execution.failed") {
        yield { type: "error", message: d.error?.message ?? "The model request failed." };
        return;
      } else if (ev.type === "session.execution.interrupted") {
        yield { type: "error", message: "Stopped." };
        return;
      } else if (ev.type === "session.execution.succeeded") {
        yield { type: "done", model: MODEL.name };
        return;
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    stream.abort();
    if (signal.aborted) await oc.fetch(`/api/session/${encodeURIComponent(session)}/interrupt`, { method: "POST" }).catch(() => {});
  }
}
