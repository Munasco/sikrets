import { redact, type Secret } from "../core/secret.ts";

// Runs a password manager's CLI. Values move only through stdin, stdout and environment variables,
// never argv, where any other process on the machine could read them with `ps`.

export interface CliSpec {
  name: string;
  bin: string;
  /** Env var that overrides the command, e.g. SIKRETS_BW="bunx @bitwarden/cli". */
  binEnv: string;
  install: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  /** Let the CLI talk to the terminal itself (its own password or 2FA prompts). Stdout is still captured. */
  interactive?: boolean;
  /** Masked out of any error message. */
  secrets?: Secret[];
}

export function command(spec: CliSpec, env: Record<string, string | undefined> = Bun.env): string[] {
  const [bin, ...rest] = (env[spec.binEnv]?.trim() || spec.bin).split(/\s+/);
  const found = Bun.which(bin!, { PATH: env.PATH ?? "" });
  if (!found) throw new Error(`${spec.name} CLI (${bin}) isn't installed or isn't on PATH. Install it: ${spec.install} (or set ${spec.binEnv})`);
  return [found, ...rest];
}

export async function runCli(spec: CliSpec, args: string[], opts: RunOptions = {}): Promise<string> {
  const env = { ...Bun.env, ...opts.env };
  const proc = Bun.spawn([...command(spec, env), ...args], {
    env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : opts.interactive ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: opts.interactive ? "inherit" : "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), opts.interactive ? "" : new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  if (code !== 0) {
    const reason = redact((err || out).trim().split("\n").at(-1) ?? "", opts.secrets ?? []);
    throw new Error(`${spec.bin} ${args[0]} failed${reason ? `: ${reason}` : ` (exit ${code})`}`);
  }
  return out;
}
