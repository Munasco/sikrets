import { providerEnv, toProcessEnv, type Env } from "../core/credentials.ts";
import { projectContext } from "../core/config.ts";
import { state } from "../core/state.ts";
import { record } from "../core/activity.ts";
import { openVault } from "../core/vault.ts";

/** This project's values from the vault, still wrapped in Secret. Shared with `sikrets mcp`. */
export async function projectEnv(root: string): Promise<Env> {
  const { resources } = await state.load(root);
  const { ctx } = await projectContext(root, { log: () => {} });
  const vault = await openVault(ctx.project, ctx.vault);
  const env: Env = {};
  for (const r of resources.filter((x) => x.applied)) {
    for (const key of r.envKeys) {
      const value = await vault.get(key);
      if (!value) throw new Error(`${key} is missing from the ${vault.name} vault; run sikrets apply`);
      env[key] = value;
    }
  }
  return env;
}

// Runs a command with this project's values injected as environment variables. Nothing is written
// to disk and nothing is printed; the child process is the only thing that sees the raw values.
export async function run(args: string[], opts: Record<string, unknown>) {
  if (!args.length) throw new Error("Usage: sikrets run [--providers] -- <command> [args...]");
  const root = process.cwd();
  const env = await projectEnv(root);
  // Provider admin credentials only on request, e.g. `sikrets run --providers -- terraform plan`.
  if (opts.providers) Object.assign(env, await providerEnv((await state.load(root)).resources.map((r) => r.provider)));

  const started = Date.now();
  const proc = Bun.spawn(args, { env: { ...Bun.env, ...toProcessEnv(env) }, stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  const ms = Date.now() - started;
  // Only the program name is logged, not its arguments, which could contain anything.
  await record(root, { kind: "run", detail: `${args[0]!.split("/").at(-1)} (exit ${code}, ${(ms / 1000).toFixed(1)}s)`, keys: Object.keys(env), exitCode: code, ms });
  process.exitCode = code;
}
