import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { extract } from "./patterns.ts";
import { runTool, TOOLS } from "./tools.ts";
import { LIMITS, MODEL, SYSTEM_PROMPT } from "./constants.ts";

// One chat turn: the model answers, calling tools as needed, and every step streams to the page.
// Secrets the user pastes never reach the model. The server swaps each one for a placeholder
// before the model sees the message, and swaps it back only inside tool calls, which run here.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; ms: number }
  | { type: "hidden"; count: number }
  | { type: "done"; model: string; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; message: string };

const client = new BedrockRuntimeClient({ region: MODEL.region });

const toolConfig = {
  tools: Object.entries(TOOLS).map(([name, t]): Tool => ({ toolSpec: { name, description: t.description, inputSchema: { json: t.schema as never } } })),
};

/** Replaces secrets with placeholders; returns the text the model may see and how to undo it. */
export function shield(messages: ChatMessage[]) {
  const vault = new Map<string, string>();
  const safe = messages.map((m) => {
    if (m.role !== "user") return m;
    let content = m.content;
    for (const { value, finding } of extract(m.content)) {
      const tag = `[[secret ${finding.redacted} #${finding.sha256.slice(0, 8)}]]`;
      vault.set(tag, value);
      content = content.split(value).join(tag);
    }
    return { ...m, content };
  });
  const reveal = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const [tag, value] of vault) s = s.split(tag).join(value);
      return s;
    }
    if (Array.isArray(v)) return v.map(reveal);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reveal(x)]));
    return v;
  };
  return { safe, reveal, hidden: vault.size };
}

export async function* chat(history: ChatMessage[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const trimmed = history.slice(-LIMITS.history).map((m) => ({ role: m.role, content: String(m.content).slice(0, LIMITS.messageChars) }));
  const { safe, reveal, hidden } = shield(trimmed);
  if (hidden) yield { type: "hidden", count: hidden };
  const messages: Message[] = safe.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: [{ text: m.content }] }));
  let model = MODEL.id;
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let step = 0; step < MODEL.maxSteps; step++) {
    let stream;
    try {
      stream = await client.send(new ConverseStreamCommand({ modelId: model, system: [{ text: SYSTEM_PROMPT }], messages, toolConfig, inferenceConfig: { maxTokens: MODEL.maxTokens, temperature: 0.2 } }), { abortSignal: signal });
    } catch (error) {
      if (model !== MODEL.fallback && step === 0) {
        model = MODEL.fallback;
        step--;
        continue;
      }
      yield { type: "error", message: `The model is unavailable: ${error instanceof Error ? error.message : String(error)}` };
      return;
    }

    const blocks: ContentBlock[] = [];
    let text = "";
    let tool: { id: string; name: string; input: string } | undefined;
    let stop: string | undefined;
    const flushText = () => {
      if (text) blocks.push({ text });
      text = "";
    };
    for await (const ev of stream.stream ?? []) {
      if (ev.contentBlockStart?.start?.toolUse) {
        flushText();
        const t = ev.contentBlockStart.start.toolUse;
        tool = { id: t.toolUseId!, name: t.name!, input: "" };
      } else if (ev.contentBlockDelta?.delta) {
        const d = ev.contentBlockDelta.delta;
        if (d.text) {
          text += d.text;
          yield { type: "text", delta: d.text };
        } else if (d.toolUse?.input && tool) tool.input += d.toolUse.input;
        else if (d.reasoningContent?.text) yield { type: "reasoning", delta: d.reasoningContent.text };
      } else if (ev.contentBlockStop && tool) {
        let input: unknown = {};
        try {
          input = tool.input ? JSON.parse(tool.input) : {};
        } catch {}
        blocks.push({ toolUse: { toolUseId: tool.id, name: tool.name, input: input as never } });
        tool = undefined;
      } else if (ev.messageStop) stop = ev.messageStop.stopReason;
      else if (ev.metadata?.usage) {
        usage.inputTokens += ev.metadata.usage.inputTokens ?? 0;
        usage.outputTokens += ev.metadata.usage.outputTokens ?? 0;
      }
    }
    flushText();
    if (!blocks.length) blocks.push({ text: " " });
    messages.push({ role: "assistant", content: blocks });

    const calls = blocks.filter((b) => b.toolUse).map((b) => b.toolUse!);
    if (stop !== "tool_use" || !calls.length) {
      yield { type: "done", model, usage };
      return;
    }
    const results: ContentBlock[] = [];
    for (const call of calls) {
      yield { type: "tool", id: call.toolUseId!, name: call.name!, input: call.input };
      const started = performance.now();
      const result = await runTool(call.name!, reveal(call.input));
      yield { type: "tool_result", id: call.toolUseId!, name: call.name!, result, ms: Math.round(performance.now() - started) };
      results.push({ toolResult: { toolUseId: call.toolUseId!, content: [{ json: result as never }], status: (result as { error?: string })?.error ? "error" : "success" } });
    }
    messages.push({ role: "user", content: results });
  }
  yield { type: "text", delta: "\n\n(Stopped after several tool calls; ask me to continue.)" };
  yield { type: "done", model, usage };
}
