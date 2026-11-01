import type { Plugin } from "@opencode/plugin";
import { runTool, TOOLS } from "../src/tools.ts";
import { Vault } from "../src/redact.ts";

// The Sikrets opencode plugin: the guard agent's five tools, and the hooks that keep pasted
// secrets from the model, the session store and the logs.
//
// 1. prompt: secrets in a user message are swapped for placeholders at admission, before opencode
//    stores the message or emits it as an event. Only this process's memory keeps the real values.
// 2. tools: the model passes placeholders; each tool swaps them back here, on the server, and returns
//    redacted findings only.
// 3. context: every outgoing model request is scanned again, and any tool the guard agent shouldn't
//    have is dropped, whatever the config says.
// 4. http.request: the last check before bytes leave. A request that still holds a known secret is
//    refused, so a missed path fails closed instead of leaking.

const vault = new Vault();
const OURS = new Set(Object.keys(TOOLS));

const plugin: Plugin.Plugin = {
  id: "sikrets.guard",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      event.prompt.text = vault.shield(event.sessionID, event.prompt.text).text;
      // The gateway sends text only; attachments, skills and agent mentions could carry content
      // this plugin doesn't scan, so they never get in.
      event.prompt.files = [];
      event.prompt.skills = [];
      event.prompt.agents = [];
    });

    await ctx.tool.transform((editor) => {
      for (const [name, tool] of Object.entries(TOOLS)) {
        editor.add({
          name,
          description: tool.description,
          input: tool.schema as never,
          options: { codemode: false },
          execute: async (input, context) => {
            const result = await runTool(name, vault.reveal(context.sessionID, input));
            return { content: JSON.stringify(result), metadata: { error: Boolean((result as { error?: unknown })?.error) } };
          },
        });
      }
    });

    for (const kind of ["context", "generate", "compaction"] as const) {
      await ctx.session.hook(kind, (event) => {
        vault.shieldAll(event.sessionID, event.messages);
        for (const name of Object.keys(event.tools)) if (!OURS.has(name)) delete event.tools[name];
      });
    }

    // Titles are fixed rather than generated: one less model call per chat, and nothing to leak.
    await ctx.session.hook("title", (event) => {
      event.result = "Security chat";
    });

    await ctx.session.hook("http.request", async (event) => {
      const body = await event.request.clone().text();
      if (vault.leaks(body)) throw new Error("Refused to send a request that contains a secret.");
    });
  },
};

export default plugin;
