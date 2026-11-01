import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { MODEL, OPENCODE, SYSTEM_PROMPT } from "./constants.ts";
import { TOOLS } from "./tools.ts";

// Runs opencode as a private server for the gateway: bound to loopback, behind a random password,
// with its own home directory, no project or user config, and an agent that can use nothing but
// the Sikrets tools. Its API also has file and shell endpoints, so it is never exposed directly.

const APP = path.join(import.meta.dir, "..");

/** Allow only the Sikrets tools; deny every built-in (shell, read, edit, write, webfetch, …). */
const PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  ...Object.keys(TOOLS).map((action) => ({ action, resource: "*", effect: "allow" })),
];

/** The model settings opencode runs with; tests swap in a local stand-in. */
export type ModelConfig = typeof MODEL & { settings?: Record<string, unknown> };

export interface Options {
  model?: ModelConfig;
  /** Extra plugin directories, loaded after the Sikrets plugin (tests use one to record requests). */
  plugins?: string[];
  home?: string;
  port?: number;
}

export function config(model: ModelConfig = MODEL, plugins: string[] = []) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${model.provider}/${model.id}`,
    default_agent: OPENCODE.agent,
    share: "disabled",
    update: "disable",
    snapshots: false,
    instructions: [],
    plugins: [path.join(APP, "plugin"), ...plugins],
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

/** The opencode binary for this platform, from the pinned @opencode/cli package. */
export function binary(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const pkg = `@opencode/cli-${os}-${process.arch}`;
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "bin", "opencode");
}

export interface Server {
  url: string;
  /** Calls opencode's API with the server password. */
  fetch(pathname: string, init?: RequestInit): Promise<Response>;
  stop(): void;
}

export async function start(opts: Options = {}): Promise<Server> {
  const model = opts.model ?? MODEL;
  const port = opts.port ?? OPENCODE.port;
  const home = opts.home ?? OPENCODE.home;
  const dirs = { config: path.join(home, "config"), work: path.join(home, "work") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("base64url");
  const env: Record<string, string> = {
    PATH: Bun.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    OPENCODE_CONFIG_DIR: dirs.config,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config(model, opts.plugins)),
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
  const key = Bun.env[OPENCODE.keyEnv] ?? Bun.env[model.keyEnv];
  if (key) env[model.keyEnv] = key;

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
  const server: Server = {
    url,
    fetch: (pathname, init = {}) => fetch(url + pathname, { ...init, headers: { ...init.headers, authorization: auth, "x-opencode-directory": dirs.work } }),
    stop: () => proc.kill(),
  };

  const deadline = Date.now() + OPENCODE.startupMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode exited (${proc.exitCode})`);
    const ok = await server.fetch("/api/agent").then((r) => r.ok, () => false);
    if (ok) return server;
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error("opencode didn't start in time");
}
