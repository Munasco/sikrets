import path from "node:path";
import { toProcessEnv, type Env } from "../core/credentials.ts";
import { readActivity, record } from "../core/activity.ts";
import { outputKeys } from "../core/standin.ts";
import { state } from "../core/state.ts";
import { Secret } from "../core/secret.ts";
import { MCP } from "../constants.ts";
import { projectEnv } from "./run.ts";
import { createLoginTool, LOGIN_TOOL, type LoginToolOptions } from "./mcp-login.ts";
import { LOGINS } from "../constants.ts";
import { parentIdentity, type AgentIdentity } from "../core/logins/identity.ts";

// `sikrets mcp`: an MCP server on stdio, so an agent can use this project's secrets without ever
// holding them. It can list key names, run a command with the values injected (like `sikrets run`),
// and read the activity log. Raw values never enter the protocol: command output is scrubbed of
// every value (and its base64 and URL-encoded forms) before it is returned, and there is no tool
// that reads a value. Stdout carries the protocol, so nothing else is ever printed there.
//
// What this does not stop: a command that sends a value somewhere over the network. `--allow`
// limits which programs the agent may run; use it for anything you wouldn't hand a stranger.

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Reply = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

export interface ServerOptions {
  root: string;
  /** Program names the agent may run; empty means any. */
  allow: readonly string[];
  /** Injected for tests; defaults to the project's vault. */
  loadEnv?: (root: string) => Promise<Env>;
  version?: string;
  /** The agent's name in approvals and the activity log. Defaults to the name the client sends in its first initialize. */
  agent?: string;
  /**
   * Who the agent is, for login grants: an id the client can't choose. Defaults to the program that
   * started this server (see core/logins/identity.ts); over HTTP, the authenticated client.
   */
  identify?: (name: string) => Promise<AgentIdentity | undefined>;
  /** For the login tool: the agent's browser, and test doubles. */
  logins?: LoginToolOptions;
}

const TOOLS = [
  {
    name: "list_secrets",
    title: "List secrets",
    description: "Names of the secrets and values this project has, and whether each is set. Never returns a value.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_with_secrets",
    title: "Run with secrets",
    description:
      "Run a command with this project's secrets as environment variables, e.g. [\"bun\", \"test\"]. " +
      "You get the exit code and output; any secret value in the output is replaced with [secret:NAME]. " +
      "Anything the command starts in the background is stopped when it ends. " +
      "Use this instead of reading .env files or asking the user for keys.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "array", items: { type: "string" }, minItems: 1, description: "Program and arguments (no shell)" },
        cwd: { type: "string", description: "Directory inside the project (default: project root)" },
        timeout_seconds: { type: "number", minimum: 1, maximum: MCP.maxTimeoutSeconds, description: `Default ${MCP.defaultTimeoutSeconds}` },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: "recent_activity",
    title: "Recent activity",
    description: "What happened in this project and who did it: adds, runs, rotations. Key names only.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200, description: "Default 20" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  LOGIN_TOOL,
] as const;

/** Every form a value might take in output, longest first so a shorter form can't split a longer one. */
function forms(env: Env): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, v] of Object.entries(env)) {
    if (!(v instanceof Secret)) continue;
    const raw = v.reveal();
    if (raw.length < MCP.minRedactLength) continue;
    const label = `[secret:${key}]`;
    for (const f of new Set([raw, encodeURIComponent(raw), Buffer.from(raw).toString("base64"), Buffer.from(raw).toString("base64url")])) out.push([f, label]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

export function scrub(text: string, env: Env): string {
  let out = text;
  for (const [form, label] of forms(env)) out = out.split(form).join(label);
  return out;
}

/** Scrub first, then cut: cutting first could leave half a secret behind. */
function clip(text: string, env: Env): string {
  const clean = scrub(text, env);
  if (clean.length <= MCP.maxOutputChars) return clean;
  const keep = MCP.maxOutputChars / 2;
  return `${clean.slice(0, keep)}\n… ${clean.length - MCP.maxOutputChars} characters omitted …\n${clean.slice(-keep)}`;
}

/** Reads until EOF, the limit, or `stop` aborts (then it cancels the stream and keeps what it has). */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void, stop: AbortSignal): Promise<{ text: string; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  stop.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (done) break;
      size += value.length;
      if (size > limit) {
        onOverflow();
        cancel();
        return { text: "", overflow: true };
      }
      chunks.push(value);
    }
  } finally {
    stop.removeEventListener("abort", cancel);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow: false };
}

/** Why a command stopped running. Only the first reason counts. */
type RunState = "running" | "exited" | "timed-out" | "overflow" | "cancelled";

/** Signals a whole process group (the command was spawned as its leader), so children it started go too. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export function createServer(opts: ServerOptions) {
  const root = path.resolve(opts.root);
  const loadEnv = opts.loadEnv ?? projectEnv;
  const login = createLoginTool(opts.logins ?? {});
  // Clients name themselves in initialize. The name is only a label the person sees; grants are
  // bound to `identity`. Only the first initialize counts, so a client can't rename itself later.
  let phase: "uninitialized" | "initialized" = "uninitialized";
  let agent = opts.agent ?? LOGINS.unknownAgent;
  let identity: Promise<AgentIdentity | undefined> | undefined;
  const whoIs = async (): Promise<AgentIdentity | { name: string }> => {
    identity ??= (opts.identify ?? parentIdentity)(agent).catch(() => undefined);
    return (await identity) ?? { name: agent };
  };

  async function runWithSecrets(args: Record<string, unknown>, signal?: AbortSignal) {
    const command = args.command;
    if (!Array.isArray(command) || !command.length || !command.every((c) => typeof c === "string")) return text("command must be a non-empty array of strings", true);
    const program = path.basename(command[0] as string);
    if (opts.allow.length && !opts.allow.includes(program))
      return text(`"${program}" isn't allowed here. Allowed: ${opts.allow.join(", ")}. The user can change this with sikrets mcp --allow.`, true);
    const cwd = path.resolve(root, typeof args.cwd === "string" ? args.cwd : ".");
    if (cwd !== root && !cwd.startsWith(root + path.sep)) return text("cwd must be inside the project", true);
    const timeout = Math.min(MCP.maxTimeoutSeconds, Math.max(1, Number(args.timeout_seconds) || MCP.defaultTimeoutSeconds));
    if (signal?.aborted) return text("cancelled", true);

    const env = await loadEnv(root);
    const started = Date.now();
    // Its own process group: stopping the command stops everything it started, and those all hold the secrets.
    // (`detached` makes the child a process-group leader; bun-types doesn't list it yet.)
    const options = { cwd, env: { ...Bun.env, ...toProcessEnv(env) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true } as const;
    const spawn = () => Bun.spawn(command, options);
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn();
    } catch (error) {
      return text(scrub(`Couldn't start ${program}: ${error instanceof Error ? error.message : String(error)}`, env), true);
    }

    let state = "running" as RunState;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const giveUpReading = new AbortController();
    // SIGTERM the group, SIGKILL it after a grace period, then stop waiting on pipes someone outside the group still holds.
    const terminate = () => {
      signalGroup(proc.pid, "SIGTERM");
      timers.push(
        setTimeout(() => {
          signalGroup(proc.pid, "SIGKILL");
          timers.push(setTimeout(() => giveUpReading.abort(), MCP.readDeadlineMs));
        }, MCP.killGraceMs),
      );
    };
    const stop = (why: Exclude<RunState, "running">) => {
      if (state !== "running") return;
      state = why;
      terminate();
    };
    timers.push(setTimeout(() => stop("timed-out"), timeout * 1000));
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    const reads = Promise.all([
      readCapped(proc.stdout, MCP.maxCaptureBytes, () => stop("overflow"), giveUpReading.signal),
      readCapped(proc.stderr, MCP.maxCaptureBytes, () => stop("overflow"), giveUpReading.signal),
    ]);
    const code = await proc.exited;
    // The command is done; anything it left behind in its group goes with it.
    stop("exited");
    const [out, err] = await reads;
    for (const t of timers) clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
    const ms = Date.now() - started;
    await record(root, { kind: "run", detail: `mcp: ${program} (${state === "exited" ? `exit ${code}` : state}, ${(ms / 1000).toFixed(1)}s)`, keys: Object.keys(env), exitCode: code, ms });

    const status =
      state === "timed-out" ? `timed out after ${timeout}s`
      : state === "overflow" ? "stopped: output over the capture limit"
      : state === "cancelled" ? "cancelled"
      : `exit ${code}`;
    const parts = [`${program}: ${status}, ${(ms / 1000).toFixed(1)}s`];
    if (out.text) parts.push(`stdout:\n${clip(out.text, env)}`);
    if (err.text) parts.push(`stderr:\n${clip(err.text, env)}`);
    return text(parts.join("\n\n"), code !== 0 || state !== "exited");
  }

  async function listSecrets() {
    const { resources } = await state.load(root);
    const env = await loadEnv(root).catch(() => ({}) as Env);
    const rows = resources.filter((r) => r.applied).flatMap(outputKeys);
    const lines = rows.map(({ key, sensitive }) => `${key in env ? "●" : "○"} ${key}${sensitive ? " (secret)" : ""}${key in env ? "" : " (missing)"}`);
    return text(lines.length ? lines.join("\n") : "This project has no values yet. The user can add one with: sikrets add <provider/service>");
  }

  async function recentActivity(args: Record<string, unknown>) {
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 20));
    const entries = (await readActivity(root)).slice(-limit);
    if (!entries.length) return text("No activity yet.");
    return text(entries.map((e) => `${e.at.slice(0, 19)} ${e.user} ${e.kind} ${e.detail}${e.keys?.length ? ` [${e.keys.join(", ")}]` : ""}`).join("\n"));
  }

  // Requests in flight, so a client can cancel one (notifications/cancelled) and close() can stop them all.
  const inFlight = new Map<string, AbortController>();
  const key = (id: unknown) => `${typeof id}:${String(id)}`;

  /** Runs one request. Aborting `signal` (or a matching notifications/cancelled) stops its command. */
  async function handle(req: Request, signal?: AbortSignal): Promise<Reply | undefined> {
    if (req.id === undefined) {
      // Notifications need no reply. A cancelled one stops the request it names.
      if (req.method === "notifications/cancelled") inFlight.get(key(req.params?.requestId))?.abort();
      return undefined;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const k = key(req.id);
    inFlight.set(k, controller);
    try {
      const reply = await dispatch(req, controller.signal);
      // A cancelled request gets no reply: the client has stopped waiting for it.
      return controller.signal.aborted ? undefined : reply;
    } finally {
      if (inFlight.get(k) === controller) inFlight.delete(k);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Stops every running command, e.g. when the client disconnects, and lets go of the browser. */
  function close() {
    for (const c of inFlight.values()) c.abort();
    void login.release();
  }

  async function dispatch(req: Request, signal: AbortSignal): Promise<Reply> {
    const id = req.id ?? null;
    const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

    switch (req.method) {
      case "initialize": {
        const client = (req.params?.clientInfo as { name?: unknown } | undefined)?.name;
        if (phase === "uninitialized" && !identity && !opts.agent && typeof client === "string" && client.trim()) agent = client.trim().slice(0, 64);
        phase = "initialized";
        return ok({
          // Answer with the client's version: this server only uses tools, which every version has.
          protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : MCP.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sikrets", title: "Sikrets", version: opts.version ?? "0.0.0" },
          instructions:
            "Use run_with_secrets to run anything that needs this project's API keys. Never ask the user to paste a key, " +
            "and don't read .env files for secrets: values there are stand-ins. To sign in to a website, open its sign-in page " +
            "in the shared browser and call login; never ask the user for a password or 2FA code.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = req.params?.name;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          if (name === "list_secrets") return ok(await listSecrets());
          if (name === "run_with_secrets") return ok(await runWithSecrets(args, signal));
          if (name === "recent_activity") return ok(await recentActivity(args));
          if (name === "login") return ok(await login(args, await whoIs()));
          return fail(-32602, `Unknown tool: ${String(name)}`);
        } catch (error) {
          // Errors can quote values (a provider error body, a bad path); never pass one through raw.
          const env = await loadEnv(root).catch(() => ({}) as Env);
          return ok(text(scrub(error instanceof Error ? error.message : String(error), env), true));
        }
      }
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  }

  return { handle, close };
}

export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = typeof opts.root === "string" ? opts.root : process.cwd();
  const allow = Array.isArray(opts.allow) ? (opts.allow as string[]) : [];
  const { version } = (await import("../../package.json")).default;
  const agent = typeof opts.agent === "string" ? opts.agent : undefined;
  const browser = typeof opts.browser === "string" ? opts.browser : undefined;
  const server = createServer({ root, allow, version, agent, logins: { browser } });
  const write = (reply: Reply) => process.stdout.write(JSON.stringify(reply) + "\n");

  console.error(`sikrets mcp: serving ${path.resolve(root)}${allow.length ? ` (allowed: ${allow.join(", ")})` : ""}`);
  let buffer = "";
  const pending = new Set<Promise<void>>();
  // Leaving (stdin closed, or a signal) stops every running command: they hold the secrets.
  const shutdown = async () => {
    server.close();
    await Promise.all(pending);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => void shutdown().then(() => process.exit(0)));
  for await (const chunk of Bun.stdin.stream()) {
    buffer += Buffer.from(chunk).toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: Request;
      try {
        req = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      // Requests run concurrently, so a long command doesn't block a ping.
      const p = server.handle(req).then((reply) => void (reply && write(reply)));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
  }
  await shutdown();
}
