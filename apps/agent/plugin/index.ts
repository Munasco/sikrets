import type { Plugin } from "@opencode/plugin";
import { runTool, TOOLS } from "../src/tools.ts";
import { Vault } from "../src/redact.ts";
import { BRAND, MCP, OPENCODE, PROXY, SHELL_ENV, SKILLS } from "../src/constants.ts";
import { loadSkills, mcpTool } from "../src/capabilities.ts";

// The Sikrets opencode plugin: the guard agent's five tools, its skills, and the hooks that keep
// pasted secrets from the model, the session store, the logs and MCP servers.
//
// 1. prompt: secrets in a user message are swapped for placeholders at admission, before opencode
//    stores the message or emits it as an event. Only this process's memory keeps the real values.
//    Attachments and agent mentions are dropped; skill mentions are kept only for our own skills.
// 2. tools: the model passes placeholders; each Sikrets tool swaps them back here, on the server,
//    and returns redacted findings only. MCP tools never get the real values: their input is
//    redacted again on the way out, and their output on the way back, before opencode stores it.
// 3. context: every outgoing model request is scanned again, and the tools of MCP servers this
//    owner switched off are dropped, whatever the config says. opencode's own namespace (tools
//    that manage the server itself) is removed when the tools are registered.
// 4. identity: opencode's own system text (its <env> block, notes about its own tools) and tool
//    descriptions name opencode, its paths and its tool ids. Every system part and tool the model
//    gets is rewritten under Sikrets names first, so the agent can't say what it runs on.
// 5. shell: commands the agent runs get a bare environment (PATH and a few basics), so the
//    server's own settings and passwords aren't there to read. (MCP servers get the same, from
//    their launcher: src/capabilities.ts.)
// 6. http.request: the last check before bytes leave. A request that still holds a known secret is
//    refused, so a missed path fails closed instead of leaking.
//
// Tools in PROXY.ask (downloading someone's repo) ask first: opencode holds the call and the client
// shows a permission prompt.

interface Options {
  skillsDir?: string;
  /** Each MCP server's default switch and tool allowlist (src/opencode.ts). */
  mcp?: Record<string, { enabled: boolean; tools?: string[] }>;
  /** The agent's scratch directory, inside its working directory; shells get it as TMPDIR. */
  tmpDir?: string;
}

const hide = (text: string) => text.replace(BRAND.hidden, BRAND.name);

/** opencode's <env> block, rebuilt with what's useful and nothing that names opencode. */
function environment(block: string, tmpDir: string | undefined) {
  const dir = /Working directory:\s*(.*)/.exec(block)?.[1]?.trim();
  return [
    "<env>",
    ...(dir ? [`  Working directory: ${dir}`] : []),
    ...(tmpDir ? [`  Scratch directory: ${tmpDir} (inside the working directory; use it instead of /tmp, it is also $TMPDIR)`] : []),
    `  Platform: ${process.platform}`,
    "</env>",
  ].join("\n");
}

/** Rewrites the system parts in place: drops the lines that are notes about opencode's own tools,
 * rebuilds the env block, and renames anything left. */
function scrubSystem(system: Array<{ text: string }>, tmpDir?: string) {
  for (let i = system.length - 1; i >= 0; i--) {
    const part = system[i]!;
    const text = part.text
      .split("\n")
      .filter((line) => !BRAND.dropSystem.some((re) => re.test(line)))
      .join("\n")
      .replace(/<env>[\s\S]*?<\/env>/g, (block) => environment(block, tmpDir));
    if (text.trim()) part.text = hide(text);
    else system.splice(i, 1);
  }
}

/** Every string in a tool's description and input schema, renamed. */
function scrubDeep<T>(v: T): T {
  if (typeof v === "string") return hide(v) as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) as T;
  return v;
}

const vault = new Vault();
/** MCP servers the owner switched off, as the gateway reports them; undefined until it does (each
 * server's default applies). One owner per instance, so it covers every session, subagents' too.
 * Module-wide, like the vault: opencode may set the plugin up more than once. */
let off: Set<string> | undefined;

/** On Linux, marks this process (opencode) non-dumpable, so the agent's shell, running as the same
 * user, can't read its environment (the server password, the config with MCP servers' variables,
 * the model relay's token) from /proc/<pid>/environ, or attach to it. Children reset the flag
 * when they exec, so their own /proc entries are unaffected. */
function undumpable() {
  if (process.platform !== "linux") return;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
    const PR_SET_DUMPABLE = 4;
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) throw new Error("prctl failed");
  } catch (e) {
    console.error(`sikrets: couldn't make the server non-dumpable: ${e}`);
  }
}
undumpable();

const plugin: Plugin.Plugin = {
  id: "sikrets.guard",
  async setup(ctx) {
    const opts = ctx.options as Options;
    const servers = opts.mcp ?? {};
    const skills = opts.skillsDir ? loadSkills(opts.skillsDir) : [];
    const skillIDs = new Set(skills.map((s) => s.id));
    const defaultOff = new Set(Object.entries(servers).filter(([, s]) => !s.enabled).map(([name]) => name));

    /** Whether the owner may use a tool, by name: every tool but the MCP ones they switched off. */
    const usable = (tool: string) => {
      const m = mcpTool(servers, tool);
      if (!m) return true;
      if ((off ?? defaultOff).has(m.server)) return false;
      const only = servers[m.server]!.tools;
      return !only || only.includes(m.name);
    };

    // The gateway (which alone holds the server password) says which servers a session may use.
    const method = { input: { type: "object" }, output: { type: "object" } };
    await ctx.rpc.register({ id: MCP.rpc.id, methods: { [MCP.rpc.method]: method, [MCP.rpc.tools]: method }, events: {} } as never, {
      [MCP.rpc.tools]: async () => ({ tools: (await ctx.tool.list()).map((t) => t.id).filter((id) => mcpTool(servers, id)) }),
      [MCP.rpc.method]: async (input: unknown) => {
        const { off: names } = (input ?? {}) as { off?: unknown };
        if (!Array.isArray(names)) return { ok: false };
        off = new Set(names.filter((n): n is string => typeof n === "string"));
        return { ok: true };
      },
    } as never);

    // Our skills are the only skills: opencode's built-in ones are about opencode itself.
    await ctx.skill.transform((editor) => {
      for (const s of editor.list()) editor.remove(s.id);
      for (const s of skills) editor.add({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}), path: s.path, content: s.content } as never);
    });

    await ctx.session.hook("prompt", (event) => {
      event.prompt.text = vault.shield(event.sessionID, event.prompt.text).text;
      // The gateway sends text and skill ids only; attachments and agent mentions could carry
      // content this plugin doesn't scan, so they never get in. Skills are our own files, redacted
      // when they're loaded.
      event.prompt.files = [];
      event.prompt.agents = [];
      event.prompt.skills = (event.prompt.skills ?? []).filter((s) => skillIDs.has(s.id)).slice(0, SKILLS.perPrompt).map((s) => ({ id: s.id }) as never);
    });

    await ctx.tool.transform((editor) => {
      // opencode's tools for managing itself (sessions, worktrees, models, MCP resources): the
      // gateway owns all of that, and their ids name opencode.
      for (const t of editor.list()) {
        const ns = (t.options as { namespace?: string } | undefined)?.namespace;
        if (ns === OPENCODE.ownNamespace || t.id.startsWith(`${OPENCODE.ownNamespace}.`) || t.id.startsWith(`${OPENCODE.ownNamespace}_`)) editor.remove(t.id);
      }
      for (const [name, tool] of Object.entries(TOOLS)) {
        editor.add({
          name,
          description: tool.description,
          input: tool.schema as never,
          options: { codemode: false },
          execute: async (input, context) => {
            if (PROXY.ask.includes(name)) {
              const target = String((input as { repo?: unknown }).repo ?? "*");
              await ctx.permission.assert({
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
                action: name,
                resources: [target],
                save: [target],
                metadata: { reason: `Downloads ${target} from GitHub to scan it.` },
              });
            }
            const result = await runTool(name, vault.reveal(context.sessionID, input));
            return { content: JSON.stringify(result), metadata: { error: Boolean((result as { error?: unknown })?.error) } };
          },
        });
      }
    });

    // MCP tools: a call to a server that's off for this session is refused, whatever the model
    // tried; inputs and outputs are redacted (placeholders stay placeholders: an MCP server is
    // someone else's code, so it never gets a pasted key).
    await ctx.tool.hook("execute.before", (event) => {
      if (!mcpTool(servers, event.tool)) return;
      if (!usable(event.tool)) throw new Error(`${event.tool} isn't switched on for this chat.`);
      event.input = vault.shieldDeep(event.sessionID, structuredClone(event.input));
    });
    await ctx.tool.hook("execute.after", (event) => {
      if (!mcpTool(servers, event.tool) || event.status !== "completed") return;
      event.result = vault.shieldDeep(event.sessionID, structuredClone(event.result));
    });

    for (const kind of ["context", "generate", "compaction"] as const) {
      await ctx.session.hook(kind, (event) => {
        vault.shieldAll(event.sessionID, event.messages);
        for (const name of Object.keys(event.tools)) if (!usable(name)) delete event.tools[name];
        scrubSystem(event.system as Array<{ text: string }>, opts.tmpDir);
        for (const [name, tool] of Object.entries(event.tools)) event.tools[name] = { description: hide(tool.description), input: scrubDeep(tool.input) };
      });
    }

    await ctx.shell.hook("create.before", (event) => {
      const keep = Object.fromEntries(SHELL_ENV.map((k) => [k, event.env[k]]).filter(([, v]) => v !== undefined));
      for (const k of Object.keys(event.env)) delete event.env[k];
      Object.assign(event.env, keep, { HOME: event.cwd }, opts.tmpDir ? { TMPDIR: opts.tmpDir } : {});
    });

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
