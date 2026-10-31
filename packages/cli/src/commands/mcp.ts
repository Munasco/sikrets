import path from "node:path";
import { toProcessEnv, type Env } from "../core/credentials.ts";
import { readActivity, record } from "../core/activity.ts";
import { outputKeys } from "../core/standin.ts";
import { state } from "../core/state.ts";
import { Secret } from "../core/secret.ts";
import { MCP } from "../constants.ts";
import { projectEnv } from "./run.ts";

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

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, onOverflow: () => void): Promise<{ text: string; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      onOverflow();
      return { text: "", overflow: true };
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow: false };
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export function createServer(opts: ServerOptions) {
  const root = path.resolve(opts.root);
  const loadEnv = opts.loadEnv ?? projectEnv;

  async function runWithSecrets(args: Record<string, unknown>) {
    const command = args.command;
    if (!Array.isArray(command) || !command.length || !command.every((c) => typeof c === "string")) return text("command must be a non-empty array of strings", true);
    const program = path.basename(command[0] as string);
    if (opts.allow.length && !opts.allow.includes(program))
      return text(`"${program}" isn't allowed here. Allowed: ${opts.allow.join(", ")}. The user can change this with sikrets mcp --allow.`, true);
    const cwd = path.resolve(root, typeof args.cwd === "string" ? args.cwd : ".");
    if (cwd !== root && !cwd.startsWith(root + path.sep)) return text("cwd must be inside the project", true);
    const timeout = Math.min(MCP.maxTimeoutSeconds, Math.max(1, Number(args.timeout_seconds) || MCP.defaultTimeoutSeconds));

    const env = await loadEnv(root);
    const started = Date.now();
    const spawn = () => Bun.spawn(command, { cwd, env: { ...Bun.env, ...toProcessEnv(env) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn();
    } catch (error) {
      return text(scrub(`Couldn't start ${program}: ${error instanceof Error ? error.message : String(error)}`, env), true);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout * 1000);
    const stop = () => proc.kill();
    const [out, err] = await Promise.all([readCapped(proc.stdout, MCP.maxCaptureBytes, stop), readCapped(proc.stderr, MCP.maxCaptureBytes, stop)]);
    const code = await proc.exited;
    clearTimeout(timer);
    const ms = Date.now() - started;
    await record(root, { kind: "run", detail: `mcp: ${program} (exit ${code}, ${(ms / 1000).toFixed(1)}s)`, keys: Object.keys(env), exitCode: code, ms });

    const status = timedOut ? `timed out after ${timeout}s` : out.overflow || err.overflow ? "stopped: output over the capture limit" : `exit ${code}`;
    const parts = [`${program}: ${status}, ${(ms / 1000).toFixed(1)}s`];
    if (out.text) parts.push(`stdout:\n${clip(out.text, env)}`);
    if (err.text) parts.push(`stderr:\n${clip(err.text, env)}`);
    return text(parts.join("\n\n"), code !== 0 || timedOut);
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

  async function handle(req: Request): Promise<Reply | undefined> {
    const id = req.id ?? null;
    const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (req.id === undefined) return undefined; // notifications (initialized, cancelled) need no reply

    switch (req.method) {
      case "initialize":
        return ok({
          // Answer with the client's version: this server only uses tools, which every version has.
          protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : MCP.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sikrets", title: "Sikrets", version: opts.version ?? "0.0.0" },
          instructions:
            "Use run_with_secrets to run anything that needs this project's API keys. Never ask the user to paste a key, " +
            "and don't read .env files for secrets: values there are stand-ins.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = req.params?.name;
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          if (name === "list_secrets") return ok(await listSecrets());
          if (name === "run_with_secrets") return ok(await runWithSecrets(args));
          if (name === "recent_activity") return ok(await recentActivity(args));
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

  return { handle };
}

export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = typeof opts.root === "string" ? opts.root : process.cwd();
  const allow = Array.isArray(opts.allow) ? (opts.allow as string[]) : [];
  const { version } = (await import("../../package.json")).default;
  const server = createServer({ root, allow, version });
  const write = (reply: Reply) => process.stdout.write(JSON.stringify(reply) + "\n");

  console.error(`sikrets mcp: serving ${path.resolve(root)}${allow.length ? ` (allowed: ${allow.join(", ")})` : ""}`);
  let buffer = "";
  const pending = new Set<Promise<void>>();
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
  await Promise.all(pending);
}
