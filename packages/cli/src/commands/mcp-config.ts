import os from "node:os";
import path from "node:path";
import { copyFile } from "node:fs/promises";
import { readText } from "../core/fs.ts";
import { confirm } from "../ui.ts";
import { MCP_APPS, MCP_HTTP } from "../constants.ts";

// `sikrets mcp config <app>` prints the snippet that connects an app to Sikrets; `sikrets mcp
// install <app>` writes it into a local app's config after asking. Snippets never contain a token:
// over HTTP they read it from $SIKRETS_MCP_TOKEN (or the app's own secret prompt), which you fill
// with `sikrets mcp clients token <name>`.

export const APPS = {
  "claude-code": { title: "Claude Code", local: true },
  "claude-desktop": { title: "Claude Desktop", local: true },
  cursor: { title: "Cursor", local: true },
  vscode: { title: "VS Code (GitHub Copilot)", local: true },
  windsurf: { title: "Windsurf / Devin Desktop", local: true },
  "gemini-cli": { title: "Gemini CLI", local: true },
  antigravity: { title: "Google Antigravity", local: true },
  codex: { title: "OpenAI Codex CLI", local: true },
  "grok-build": { title: "Grok Build (CLI)", local: true },
  zed: { title: "Zed", local: true },
  chatgpt: { title: "ChatGPT", local: false },
  claude: { title: "Claude (claude.ai, and connectors in Claude Desktop and mobile)", local: false },
  grok: { title: "Grok (grok.com)", local: false },
  gemini: { title: "Gemini app (gemini.google.com)", local: false },
} as const;

export type AppId = keyof typeof APPS;
export const INSTALLABLE = ["claude-code", "claude-desktop", "cursor", "vscode", "gemini-cli", "antigravity"] as const satisfies readonly AppId[];

export interface SnippetInput {
  app: AppId;
  /** How to start Sikrets: the program and any leading arguments (absolute, for apps with a bare PATH). */
  command: string[];
  /** Project folder the stdio server serves. */
  root: string;
  /** Streamable HTTP URL; when set, the snippet connects over HTTP instead of starting a process. */
  url?: string;
  platform?: NodeJS.Platform;
}

export interface Snippet {
  title: string;
  /** Where it goes: a file path, or undefined for steps in an app's settings. */
  file?: string;
  format: "json" | "toml" | "shell" | "steps";
  /** The JSON object to merge (json format only), keyed the way the app expects. */
  value?: Record<string, unknown>;
  text: string;
}

const NAME = MCP_APPS.serverName;
const ENV = MCP_HTTP.tokenEnv;
const bearer = (ref: string) => ({ Authorization: `Bearer ${ref}` });
const jsonSnippet = (title: string, file: string, value: Record<string, unknown>): Snippet => ({ title, file, format: "json", value, text: JSON.stringify(value, null, 2) });
const tomlString = (s: string) => JSON.stringify(s);

const REMOTE_NOTE = (url: string | undefined) =>
  url && !/^https:\/\//.test(url)
    ? `\nThis app connects from its own servers, so it needs an https URL that reaches this machine (a tunnel), not ${url}. See docs/mcp.md.`
    : "";

export function snippet(input: SnippetInput): Snippet {
  const { app, root } = input;
  const [cmd, ...pre] = input.command;
  const args = [...pre, "mcp", "--root", root];
  const stdio = { command: cmd!, args };
  const url = input.url;
  const title = APPS[app].title;
  const platform = input.platform ?? process.platform;

  switch (app) {
    case "claude-code":
      // Project-scoped .mcp.json; Claude Code starts the server in the project, so no --root needed.
      return url
        ? jsonSnippet(title, MCP_APPS.claudeCodeConfig, { mcpServers: { [NAME]: { type: "http", url, headers: bearer(`\${${ENV}}`) } } })
        : jsonSnippet(title, MCP_APPS.claudeCodeConfig, { mcpServers: { [NAME]: { command: cmd, args: [...pre, "mcp"] } } });
    case "claude-desktop": {
      const file = MCP_APPS.claudeDesktopConfig[platform as keyof typeof MCP_APPS.claudeDesktopConfig] ?? MCP_APPS.claudeDesktopConfig.linux;
      if (url) return snippet({ ...input, app: "claude" });
      return jsonSnippet(title, file, { mcpServers: { [NAME]: stdio } });
    }
    case "cursor":
      return jsonSnippet(title, MCP_APPS.cursorConfig, { mcpServers: { [NAME]: url ? { url, headers: bearer(`\${env:${ENV}}`) } : stdio } });
    case "vscode":
      return jsonSnippet(
        title,
        MCP_APPS.vscodeConfig,
        url
          ? {
              inputs: [{ type: "promptString", id: "sikrets-token", description: "Sikrets MCP token (sikrets mcp clients token vscode)", password: true }],
              servers: { [NAME]: { type: "http", url, headers: bearer("${input:sikrets-token}") } },
            }
          : { servers: { [NAME]: { type: "stdio", ...stdio } } },
      );
    case "windsurf":
      return jsonSnippet(title, MCP_APPS.windsurfConfig, { mcpServers: { [NAME]: url ? { serverUrl: url, headers: bearer(`\${env:${ENV}}`) } : stdio } });
    case "gemini-cli":
      return jsonSnippet(title, MCP_APPS.geminiConfig, { mcpServers: { [NAME]: url ? { httpUrl: url, headers: bearer(`\$${ENV}`) } : { ...stdio, cwd: root } } });
    case "antigravity":
      // Antigravity has no documented env expansion in headers, so the HTTP form names where the token comes from.
      return jsonSnippet(title, MCP_APPS.antigravityConfig, {
        mcpServers: { [NAME]: url ? { serverUrl: url, headers: bearer(`<paste: sikrets mcp clients token ${app}>`) } : stdio },
      });
    case "codex": {
      const lines = [`[mcp_servers.${NAME}]`];
      if (url) lines.push(`url = ${tomlString(url)}`, `bearer_token_env_var = ${tomlString(ENV)}`);
      else lines.push(`command = ${tomlString(cmd!)}`, `args = [${args.map(tomlString).join(", ")}]`);
      return { title, file: MCP_APPS.codexConfig, format: "toml", text: lines.join("\n") };
    }
    case "grok-build": {
      const quote = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
      const text = url
        ? `grok mcp add --transport http ${NAME} ${quote(url)} --header "Authorization: Bearer \${${ENV}}"`
        : `grok mcp add ${NAME} -- ${[cmd!, ...args].map(quote).join(" ")}`;
      return { title, format: "shell", text };
    }
    case "zed":
      return jsonSnippet(title, MCP_APPS.zedConfig, {
        context_servers: { [NAME]: url ? { url, headers: bearer(`<paste: sikrets mcp clients token ${app}>`) } : { command: cmd, args, env: {} } },
      });
    case "chatgpt":
      return {
        title,
        format: "steps",
        text: [
          "ChatGPT connects from OpenAI's servers and signs in with OAuth (it can't send a fixed token).",
          "1. Start a tunnel to this machine (docs/mcp.md), then run:",
          "   sikrets mcp --http --oauth --public-url https://<your-tunnel-host> --allow <program>",
          "2. chatgpt.com: Plugins → + → Add custom MCP server (on Business/Enterprise, workspace admins can add them).",
          `   Name: Sikrets. URL: ${url ?? `https://<your-tunnel-host>${MCP_HTTP.path}`}`,
          "   Authentication: OAuth. Leave client ID and secret empty; ChatGPT registers itself.",
          "3. Create it, then approve the Sikrets prompt on your Mac (and Touch ID).",
          "Or skip the tunnel: OpenAI's Secure MCP Tunnel can run `sikrets mcp` (stdio) for you; see docs/mcp.md.",
        ].join("\n") + REMOTE_NOTE(url),
      };
    case "claude":
      return {
        title,
        format: "steps",
        text: [
          "Claude connects from Anthropic's servers and signs in with OAuth.",
          "1. Start a tunnel to this machine (docs/mcp.md), then run:",
          "   sikrets mcp --http --oauth --public-url https://<your-tunnel-host> --allow <program>",
          "2. claude.ai: Customize → Connectors → Add custom connector",
          "   (Team/Enterprise: an owner adds it under Organization settings → Connectors).",
          `   Name: Sikrets. URL: ${url ?? `https://<your-tunnel-host>${MCP_HTTP.path}`}`,
          "   OAuth client: Register automatically.",
          "3. Connect, then approve the Sikrets prompt on your Mac (and Touch ID).",
          "The connector then works in claude.ai, Claude Desktop and Claude mobile on that account.",
        ].join("\n") + REMOTE_NOTE(url),
      };
    case "grok":
      return {
        title,
        format: "steps",
        text: [
          "grok.com connects from xAI's servers; it needs a public https URL.",
          "1. Start a tunnel (docs/mcp.md), then run: sikrets mcp --http --oauth --public-url https://<your-tunnel-host> --allow <program>",
          `2. grok.com/connectors → New Connector → Custom. URL: ${url ?? `https://<your-tunnel-host>${MCP_HTTP.path}`}`,
          "3. Choose OAuth if offered and approve the Sikrets prompt on your Mac;",
          "   if it asks for an API key instead, use a token from: sikrets mcp clients add grok",
          "xAI API (Responses): add a tool {type: \"mcp\", server_url: <that URL>, server_label: \"sikrets\", authorization: <token>}.",
        ].join("\n") + REMOTE_NOTE(url),
      };
    case "gemini":
      return {
        title,
        format: "steps",
        text: [
          "The Gemini app connects from Google's servers and signs in with OAuth (US, personal accounts, English).",
          "1. Start a tunnel (docs/mcp.md), then run: sikrets mcp --http --oauth --public-url https://<your-tunnel-host> --allow <program>",
          `2. gemini.google.com: Settings → Connected Apps → Custom apps → Add a custom app. URL: ${url ?? `https://<your-tunnel-host>${MCP_HTTP.path}`}`,
          "3. Approve the Sikrets prompt on your Mac (and Touch ID).",
          "For local use, Gemini CLI or Antigravity are simpler: sikrets mcp config gemini-cli",
        ].join("\n") + REMOTE_NOTE(url),
      };
  }
}

/** How this machine starts Sikrets: the installed binary, or bun plus this script when running from source. */
export function selfCommand(): string[] {
  const installed = Bun.which("sikrets");
  if (installed) return [installed];
  if (path.basename(process.execPath).startsWith("bun")) return [process.execPath, path.resolve(Bun.main)];
  return [process.execPath];
}

export const expandHome = (file: string) => (file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file.replace(/^%APPDATA%/, Bun.env.APPDATA ?? "%APPDATA%"));

/** Merges a snippet's servers into an existing config, keeping everything else. Throws on a config it can't read. */
export function merge(existing: string | undefined, value: Record<string, unknown>): string {
  let current: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      current = JSON.parse(existing);
    } catch {
      throw new Error("The existing config isn't plain JSON (comments?). Add the snippet by hand: sikrets mcp config <app>");
    }
  }
  const out: Record<string, unknown> = { ...current };
  for (const [key, v] of Object.entries(value)) {
    const prev = out[key];
    if (Array.isArray(v)) {
      const ids = new Set(v.map((x) => (x as { id?: string }).id));
      out[key] = [...(Array.isArray(prev) ? prev.filter((x) => !ids.has((x as { id?: string }).id)) : []), ...v];
    } else out[key] = { ...(prev && typeof prev === "object" ? prev : {}), ...(v as object) };
  }
  return JSON.stringify(out, null, 2) + "\n";
}

const isApp = (app: string | undefined): app is AppId => Boolean(app && app in APPS);

function input(app: AppId, opts: Record<string, unknown>): SnippetInput {
  const root = path.resolve(typeof opts.root === "string" ? opts.root : process.cwd());
  const publicUrl = typeof opts["public-url"] === "string" ? `${opts["public-url"].replace(/\/+$/, "")}${MCP_HTTP.path}` : undefined;
  const localUrl = `http://${MCP_HTTP.defaultHost}:${Number(opts.port) || MCP_HTTP.defaultPort}${MCP_HTTP.path}`;
  // Cloud apps can only use a public URL; without one their steps show a placeholder.
  const url = typeof opts.url === "string" ? opts.url : publicUrl ?? (opts.http && APPS[app].local ? localUrl : undefined);
  return { app, command: selfCommand(), root, url };
}

const appList = () => Object.entries(APPS).map(([id, a]) => `  ${id.padEnd(15)} ${a.title}`).join("\n");

export async function config(app: string | undefined, opts: Record<string, unknown>) {
  if (!isApp(app)) throw new Error(`${app ? `Unknown app "${app}". ` : ""}Usage: sikrets mcp config <app> [--http]\n\nApps\n${appList()}`);
  const s = snippet(input(app, opts));
  if (s.file) console.error(`${s.title}: add this to ${s.file}${s.format === "json" ? " (merge with what's there)" : ""}`);
  else console.error(s.title);
  console.log(s.text);
  if (s.text.includes(MCP_HTTP.tokenEnv))
    console.error(`\nThe token comes from $${MCP_HTTP.tokenEnv}. Create one with: sikrets mcp clients add ${app}\nthen: export ${MCP_HTTP.tokenEnv}="$(sikrets mcp clients token ${app})"`);
}

export async function install(app: string | undefined, opts: Record<string, unknown>) {
  if (!isApp(app) || !(INSTALLABLE as readonly string[]).includes(app))
    throw new Error(`Usage: sikrets mcp install <app>. Installable: ${INSTALLABLE.join(", ")}. For others: sikrets mcp config <app>`);
  const inp = input(app, opts);
  const s = snippet(inp);
  if (!s.file || !s.value) throw new Error(`Nothing to install for ${app}; see sikrets mcp config ${app}`);
  const file = path.isAbsolute(expandHome(s.file)) ? expandHome(s.file) : path.join(inp.root, s.file);
  const existing = await readText(file);
  const next = merge(existing, s.value);
  console.error(`${s.title}: ${existing ? "update" : "create"} ${file} with:\n${s.text}`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error("No terminal to confirm in; rerun with --yes");
    if (!(await confirm("Write it?"))) return console.error("Nothing written.");
  }
  if (existing) await copyFile(file, `${file}.bak`);
  await Bun.write(file, next);
  console.error(`Wrote ${file}${existing ? ` (previous version in ${path.basename(file)}.bak)` : ""}. Restart ${s.title} to pick it up.`);
}
