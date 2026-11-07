import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MCP, OPENCODE, SHELL_ENV, SKILLS } from "./constants.ts";
import { shield } from "./redact.ts";
import { TOOLS } from "./tools.ts";

// What the guard can do beyond its own tools: skills (SKILL.md playbooks shipped in SKILLS.dir) and
// MCP servers (configured on the gateway's side in MCP.file). The same way in as t3code's: skills are
// discovered from SKILL.md frontmatter and picked in the chat with `$name`; MCP tools are
// `<server>_<tool>` and gated by permission rules per server. Both are loaded here, once, for the
// opencode config (src/opencode.ts), the plugin (plugin/index.ts) and the gateway's proxy.

export interface Skill {
  id: string;
  name: string;
  description?: string;
  path: string;
  /** The playbook, with anything secret-shaped already swapped for placeholders. */
  content: string;
}

/** Reads `name:` and `description:` from a SKILL.md's YAML frontmatter; returns them and the body. */
function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: text.slice(m[0].length) };
}

/** The skills in a directory: one folder each, named by its id, holding SKILL.md. */
export function loadSkills(dir: string): Skill[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && SKILLS.id.test(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return names.flatMap((id) => {
    const file = path.join(dir, id, SKILLS.file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const { meta, body } = frontmatter(text);
    // A skill is text the model reads; it gets the same redaction as a pasted message.
    return [{ id, name: meta.name || id, ...(meta.description ? { description: meta.description } : {}), path: file, content: shield(body.trim()).text }];
  });
}

/** One MCP server as the gateway's config describes it: opencode's own fields, plus ours. */
export type McpServer = (
  | { type: "local"; command: string[]; environment?: Record<string, string> }
  | { type: "remote"; url: string; headers?: Record<string, string> }
) & {
  /** Shown in the chat's MCP list. */
  description?: string;
  /** On for a login until they switch it off (default true). */
  enabled?: boolean;
  /** Only these of the server's tools reach the model (default: all), to keep out ones that
   * repeat a tool the guard already has. */
  tools?: string[];
  timeout?: { startup?: number; catalog?: number; execution?: number };
};

export type McpServers = Record<string, McpServer>;

/** Tool names the guard already has; a server's `<name>_` prefix may not start any of them. */
const TAKEN = [...Object.keys(TOOLS), ...OPENCODE.builtins, SKILLS.tool, "opencode", "execute"];

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const stringMap = (v: unknown): v is Record<string, string> => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((s) => typeof s === "string");

/** Checks a config's servers; throws on the first problem, naming it. */
export function parseMcp(raw: unknown): McpServers {
  const servers = (raw as { servers?: unknown } | undefined)?.servers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP config: `servers` must be an object");
  const out: McpServers = {};
  for (const [name, s] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
    const bad = (why: string) => new Error(`MCP server "${name}": ${why}`);
    if (!MCP.name.test(name)) throw bad(`names are ${MCP.name}`);
    if (TAKEN.some((t) => t.startsWith(`${name}_`) || t === name)) throw bad("its tools' prefix would clash with a tool the guard has");
    const common = {
      ...(typeof s.description === "string" ? { description: s.description } : {}),
      ...(typeof s.enabled === "boolean" ? { enabled: s.enabled } : {}),
      ...(s.tools !== undefined ? (strings(s.tools) ? { tools: s.tools } : (() => { throw bad("`tools` must be a list of names"); })()) : {}),
      ...(s.timeout && typeof s.timeout === "object" ? { timeout: s.timeout as McpServer["timeout"] } : {}),
    };
    const type = s.type ?? (s.url ? "remote" : "local");
    if (type === "local") {
      if (!strings(s.command) || !s.command.length) throw bad("`command` must be a non-empty list of strings");
      const env = s.environment ?? {};
      if (!stringMap(env)) throw bad("`environment` must map names to strings");
      for (const k of Object.keys(env)) if (!MCP.envName.test(k) || MCP.envReserved.includes(k) || SHELL_ENV.includes(k)) throw bad(`can't set ${k}`);
      out[name] = { type, command: s.command, ...(Object.keys(env).length ? { environment: env } : {}), ...common };
    } else if (type === "remote") {
      const url = typeof s.url === "string" ? URL.parse(s.url) : null;
      if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw bad("`url` must be https (or http on loopback)");
      if (s.headers !== undefined && !stringMap(s.headers)) throw bad("`headers` must map names to strings");
      out[name] = { type, url: url.href, ...(s.headers ? { headers: s.headers as Record<string, string> } : {}), ...common };
    } else throw bad('`type` is "local" or "remote"');
  }
  return out;
}

/** The servers in a JSON file; none when there's no file. */
export function loadMcp(file: string): McpServers {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return parseMcp(JSON.parse(text));
}

/**
 * opencode's `mcp` config for these servers. A local server starts through `sh`, which hands it a
 * fresh environment holding only SHELL_ENV, its own HOME and the variables its config names: never
 * the model key's stand-in, the server password, or opencode's config. Each tool stays a tool of its
 * own (no Code Mode), so each is permissioned and shown by name.
 */
export function mcpConfig(servers: McpServers, home: string, env: Record<string, string | undefined> = Bun.env) {
  const entries = Object.entries(servers).map(([name, s]) => {
    const timeout = s.timeout ? { timeout: s.timeout } : {};
    if (s.type === "remote") return [name, { type: "remote", url: s.url, ...(s.headers ? { headers: s.headers } : {}), oauth: false, codemode: false, ...timeout }];
    const dir = path.join(home, MCP.homeDir, name);
    const vars: Record<string, string> = {
      ...Object.fromEntries(SHELL_ENV.map((k) => [k, env[k]]).filter((kv): kv is [string, string] => kv[1] !== undefined)),
      HOME: dir,
      ...s.environment,
    };
    // Names only (all checked against MCP.envName); the values travel in the environment.
    const launch = `exec env -i ${Object.keys(vars).map((k) => `${k}="$${k}"`).join(" ")} "$@"`;
    return [name, { type: "local", command: ["/bin/sh", "-c", launch, name, ...s.command], cwd: dir, environment: vars, codemode: false, ...timeout }];
  });
  return { servers: Object.fromEntries(entries) };
}

/** Permission rules: every tool of every server asks first, like the built-ins (Full access answers). */
export const mcpPermissions = (servers: McpServers) => Object.keys(servers).map((name) => ({ action: `${name}_*`, resource: "*", effect: "ask" as const }));

/** The server a tool name belongs to, and the tool's own name. */
export function mcpTool(servers: Pick<McpServers, string> | Record<string, unknown>, tool: string): { server: string; name: string } | undefined {
  for (const server of Object.keys(servers)) if (tool.startsWith(`${server}_`)) return { server, name: tool.slice(server.length + 1) };
  return undefined;
}
