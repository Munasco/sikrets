import { mkdirSync, realpathSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { COMMANDS, MCP, MODEL, OPENCODE, PROXY, SKILLS, SYSTEM_PROMPT } from "./constants.ts";
import { TOOLS } from "./tools.ts";
import { loadMcp, loadSkills, mcpConfig, mcpPermissions, type McpServers, type Skill } from "./capabilities.ts";

// Runs opencode as a private server for the gateway: bound to loopback, behind a random password,
// with its own home directory and no project or user config. The guard agent has the Sikrets tools,
// which run freely, and opencode's shell, file and web tools, which ask first; the owner's Full
// access switch answers those automatically (src/full-access.ts). Its API also has file and shell endpoints, so it is never exposed directly.
// It also has the skills shipped in SKILLS.dir and the MCP servers in MCP.file (src/capabilities.ts):
// skills load without asking, and every MCP tool asks first, like the built-ins.

const APP = path.join(import.meta.dir, "..");

/** The Sikrets tools run freely; opencode's built-ins (OPENCODE.builtins) and MCP tools ask first;
 * only our own skills can be loaded; nothing else. */
function permissions(skills: Skill[], mcp: McpServers) {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...Object.keys(TOOLS).map((action) => ({ action, resource: "*", effect: "allow" })),
    ...OPENCODE.builtins.map((action) => ({ action, resource: "*", effect: "ask" })),
    ...PROXY.ask.map((action) => ({ action, resource: "*", effect: "ask" })),
    ...skills.map((s) => ({ action: SKILLS.tool, resource: s.id, effect: "allow" })),
    ...mcpPermissions(mcp),
  ];
}

/** The model settings opencode runs with; tests swap in a local stand-in. */
export type ModelConfig = typeof MODEL & { settings?: Record<string, unknown> };

export interface Options {
  model?: ModelConfig;
  /** Extra plugin directories, loaded after the Sikrets plugin (tests use one to record requests). */
  plugins?: string[];
  home?: string;
  port?: number;
  /** MCP servers; by default, the ones in MCP.file. */
  mcp?: McpServers;
  /** Where the skills are; by default SKILLS.dir. */
  skillsDir?: string;
}

/** What the guard has beyond its own tools, as the gateway and plugin see it. */
export interface Capabilities {
  skills: Skill[];
  mcp: McpServers;
  skillsDir: string;
}

export function capabilities(opts: Pick<Options, "mcp" | "skillsDir"> = {}): Capabilities {
  const skillsDir = opts.skillsDir ?? path.join(APP, SKILLS.dir);
  return { skills: loadSkills(skillsDir), mcp: opts.mcp ?? loadMcp(path.resolve(APP, MCP.file)), skillsDir };
}

export function config(model: ModelConfig = MODEL, plugins: string[] = [], caps: Capabilities = capabilities(), home: string = OPENCODE.home) {
  const PERMISSIONS = permissions(caps.skills, caps.mcp);
  // The plugin learns the skills' folder and each server's switch and tool list from its options.
  const servers = Object.fromEntries(Object.entries(caps.mcp).map(([name, s]) => [name, { enabled: s.enabled !== false, ...(s.tools ? { tools: s.tools } : {}) }]));
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${model.provider}/${model.id}`,
    default_agent: OPENCODE.agent,
    share: "disabled",
    update: "disable",
    snapshots: false,
    instructions: [],
    skills: [],
    commands: Object.fromEntries(Object.entries(COMMANDS).map(([name, c]) => [name, { template: c.template, description: c.description }])),
    mcp: mcpConfig(caps.mcp, home),
    plugins: [{ package: path.join(APP, "plugin"), options: { skillsDir: caps.skillsDir, mcp: servers, tmpDir: path.join(home, OPENCODE.tmpDir) } }, ...plugins],
    permissions: PERMISSIONS,
    providers: {
      [model.provider]: {
        env: [model.keyEnv],
        package: model.package,
        ...(model.settings ? { settings: model.settings } : {}),
        models: { [model.id]: { name: model.name, limit: { context: model.context, output: model.maxTokens } } },
      },
    },
    agents: {
      [OPENCODE.agent]: {
        description: "Finds leaked credentials and walks you through rotating them.",
        mode: "primary",
        model: { providerID: model.provider, model: model.id },
        system: SYSTEM_PROMPT,
        steps: model.maxSteps,
        permissions: PERMISSIONS,
      },
      build: { disabled: true },
      plan: { disabled: true },
      general: { disabled: true },
      explore: { disabled: true },
    },
  };
}

/** A loopback relay to the model provider that accepts only `token` and sends the real key. */
function modelRelay(model: ModelConfig, key: string) {
  const upstream = new URL(String(model.settings?.baseURL ?? `https://${model.host}/${OPENCODE.relayPath}`));
  const token = randomBytes(24).toString("base64url");
  const same = (a: string) => a.length === token.length && timingSafeEqual(Buffer.from(a), Buffer.from(token));
  const server = Bun.serve({
    hostname: OPENCODE.host,
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers(req.headers);
      const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
      const given = headers.get("x-goog-api-key") ?? headers.get("x-api-key") ?? bearer ?? url.searchParams.get("key");
      if (!given || !same(given)) return new Response("Unauthorized", { status: 401 });
      for (const h of ["x-goog-api-key", "x-api-key"]) if (headers.has(h)) headers.set(h, key);
      if (bearer) headers.set("authorization", `Bearer ${key}`);
      if (url.searchParams.has("key")) url.searchParams.set("key", key);
      headers.delete("host");
      return fetch(upstream.origin + url.pathname + url.search, { method: req.method, headers, body: req.body, redirect: "manual" });
    },
  });
  return { token, baseURL: `http://${OPENCODE.host}:${server.port}${upstream.pathname.replace(/\/$/, "")}`, stop: () => server.stop(true) };
}

/** The opencode binary for this platform, from the pinned @opencode/cli package. */
export function binary(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const pkg = `@opencode/cli-${os}-${process.arch}`;
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", "opencode");
}

export interface Server {
  url: string;
  capabilities: Capabilities;
  /** opencode's private working directory, where every session runs. */
  directory: string;
  /** Calls opencode's API with the server password. */
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  stop(): void;
}

/** True once every MCP server has failed, or connected and had its tools registered. */
async function mcpSettled(server: Server) {
  if (!Object.keys(server.capabilities.mcp).length) return true;
  const read = async <T>(p: string, init?: RequestInit) => ((await (await server.fetch(p, init).catch(() => undefined))?.json().catch(() => undefined)) as T | undefined);
  const list = (await read<{ data?: Array<{ name: string; status: { status: string } }> }>("/api/mcp"))?.data;
  if (!list || list.some((m) => m.status.status === "pending")) return false;
  const rpc = `/api/rpc/${encodeURIComponent(MCP.rpc.id)}/${encodeURIComponent(MCP.rpc.tools)}`;
  const tools = (await read<{ output?: { tools?: string[] } }>(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) }))?.output?.tools ?? [];
  return list.filter((m) => m.status.status === "connected").every((m) => tools.some((t) => t.startsWith(`${m.name}_`)));
}

export async function start(opts: Options = {}): Promise<Server> {
  const model: ModelConfig = opts.model ?? MODEL;
  const port = opts.port ?? OPENCODE.port;
  // Resolved (macOS's /var is /private/var), so every path the agent is told matches what it sees.
  mkdirSync(opts.home ?? OPENCODE.home, { recursive: true, mode: 0o700 });
  const home = realpathSync(opts.home ?? OPENCODE.home);
  // tmp is the agent's scratch directory (inside work); runtime is opencode's own TMPDIR, private to it.
  const dirs = { config: path.join(home, "config"), work: path.join(home, OPENCODE.workDir), tmp: path.join(home, OPENCODE.tmpDir), runtime: path.join(home, "runtime-tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const caps = capabilities(opts);
  for (const [name, s] of Object.entries(caps.mcp)) if (s.type === "local") mkdirSync(path.join(home, MCP.homeDir, name), { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  const env: Record<string, string> = {
    PATH: Bun.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    TMPDIR: dirs.runtime,
    OPENCODE_CONFIG_DIR: dirs.config,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config(model, opts.plugins, caps, home)),
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "1",
  };
  // The model key: delivered by the enclave host (OPENCODE.keyEnv) or set locally under its own name.
  // It stays in this process. opencode, and every shell command the agent runs, gets a random
  // stand-in and a loopback relay that swaps it for the real key on the way to the provider.
  const key = Bun.env[OPENCODE.keyEnv] ?? Bun.env[model.keyEnv];
  const relay = key ? modelRelay(model, key) : undefined;
  if (relay) {
    env[model.keyEnv] = relay.token;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config({ ...model, settings: { ...model.settings, baseURL: relay.baseURL } }, opts.plugins, caps, home));
  }

  const bin = binary();
  const version = (await Bun.$`${bin} --version`.env(env).quiet().text()).trim();
  if (!version.endsWith(OPENCODE.version)) throw new Error(`opencode ${OPENCODE.version} expected, found ${version}`);

  const proc = Bun.spawn([bin, "serve", "--hostname", OPENCODE.host, "--port", String(port), "--log-level", "warn"], {
    cwd: dirs.work,
    env,
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://${OPENCODE.host}:${port}`;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  // Sessions run at the resolved path (macOS's /var is /private/var); every call names the same one,
  // so opencode keeps one instance of the plugin and the MCP servers rather than one per spelling.
  const directory = realpathSync(dirs.work);
  const server: Server = {
    url,
    capabilities: caps,
    directory,
    fetch: (pathname, init = {}) => fetch(url + pathname, { ...init, headers: { ...init.headers, authorization: auth, "x-opencode-directory": directory } }),
    stop: () => {
      proc.kill();
      relay?.stop();
    },
  };

  const deadline = Date.now() + OPENCODE.startupMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode exited (${proc.exitCode})`);
    const ok = await server.fetch("/api/agent").then((r) => r.ok, () => false);
    // Ready once every MCP server has connected or failed, so the first chat has their tools.
    if (ok && (await mcpSettled(server))) return server;
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("opencode didn't start in time");
}
