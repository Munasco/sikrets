import { providerEnv, toProcessEnv, type Env } from "../core/credentials.ts";
import { projectContext } from "../core/config.ts";
import { state } from "../core/state.ts";
import { record } from "../core/activity.ts";
import { externalKeys } from "../core/keys.ts";
import { openVault } from "../core/vault.ts";
import { authorize, currentAgent } from "../core/agents.ts";
import { recordUse } from "../core/usage.ts";

/**
 * This project's values from the vault, still wrapped in Secret. Shared with `sikrets mcp`.
 * An agent gets only the keys in its scope, and none once revoked or expired.
 */
export async function projectEnv(root: string, agent?: string): Promise<Env> {
  const { resources } = await state.load(root);
  const { ctx } = await projectContext(root, { log: () => {} });
  const vault = await openVault(ctx.project, ctx.vault);
  const live = resources.filter((x) => x.applied);
  const external = (await externalKeys(root)).map(({ key }) => key);
  const offers = [...live.flatMap((r) => r.envKeys.map((key) => ({ key, resource: r.name }))), ...external.map((key) => ({ key }))];
  const allowed = agent ? new Set((await authorize(root, agent, offers)).keys) : undefined;
  const env: Env = {};
  for (const r of live) {
    for (const key of r.envKeys.filter((k) => !allowed || allowed.has(k))) {
      const value = await vault.get(key);
      if (!value) throw new Error(`${key} is missing from the ${vault.name} vault; run sikrets apply`);
      env[key] = value;
    }
  }
  // Keys imported or linked from outside Sikrets.
  for (const key of external.filter((k) => !env[k] && (!allowed || allowed.has(k)))) {
    const value = await vault.get(key);
    if (value) env[key] = value;
  }
  return env;
}

// Runs a command with this project's values injected as environment variables. Nothing is written
// to disk and nothing is printed; the child process is the only thing that sees the raw values.
export async function run(args: string[], opts: Record<string, unknown>) {
  if (!args.length) throw new Error("Usage: sikrets run [--providers] -- <command> [args...]");
  const root = process.cwd();
  const agent = currentAgent(opts);
  if (agent && opts.providers) throw new Error("Agents don't get provider admin credentials; run that yourself");
  const env = await projectEnv(root, agent);
  // Provider admin credentials only on request, e.g. `sikrets run --providers -- terraform plan`.
  if (opts.providers) Object.assign(env, await providerEnv((await state.load(root)).resources.map((r) => r.provider)));

  const { ctx } = await projectContext(root, { log: () => {} });
  const program = args[0]!.split("/").at(-1)!;
  await recordUse(ctx.project, { keys: Object.keys(env), via: "run", app: program, ...(agent ? { agent } : {}) });

  const started = Date.now();
  const proc = Bun.spawn(args, { env: { ...Bun.env, ...toProcessEnv(env) }, stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  const ms = Date.now() - started;
  // Only the program name is logged, not its arguments, which could contain anything.
  await record(root, { kind: "run", detail: `${program} (exit ${code}, ${(ms / 1000).toFixed(1)}s)`, keys: Object.keys(env), exitCode: code, ms });
  process.exitCode = code;
}
