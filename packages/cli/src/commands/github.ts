import { authorize, currentAgent } from "../core/agents.ts";
import { projectContext } from "../core/config.ts";
import { installationToken } from "../core/github-app.ts";
import { state, type Resource } from "../core/state.ts";
import { until } from "../core/ttl.ts";
import { recordUse } from "../core/usage.ts";
import { openVault } from "../core/vault.ts";
import { log } from "../ui.ts";
import { deliver, recipient } from "./deliver.ts";
import { GITHUB } from "../constants.ts";

// `sikrets github token`: a one-hour GitHub App installation token, optionally narrowed to some
// repositories and permissions, for a command or a shell. The App's private key stays in the vault.

const USAGE = "sikrets github token";
const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

function appKey(resources: readonly Resource[], name: unknown): Resource {
  const keys = resources.filter((r) => r.applied && r.recipe === "github/app-key");
  const r = typeof name === "string" ? keys.find((k) => k.name === name) : keys.length === 1 ? keys[0] : undefined;
  if (r) return r;
  if (keys.length > 1) throw new Error(`Several GitHub App keys here (${keys.map((k) => k.name).join(", ")}); pick one with --key`);
  throw new Error(`No GitHub App key${typeof name === "string" ? ` named "${name}"` : ""} in this project. Add one: sikrets add github/app-key --value-stdin < key.pem`);
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const [sub, ...command] = args;
  if (sub !== "token") throw new Error(`Usage: ${USAGE} [--repo NAME] [--permission contents=read] (--env | -- <command>)`);
  const root = process.cwd();
  const to = recipient(command, opts, USAGE);
  const { ctx } = await projectContext(root, { log: () => {} });
  const res = appKey((await state.load(root)).resources, opts.key);
  const keyName = res.envKeys[0]!;
  const appId = String(res.inputs.app_id ?? "");
  const installationId = typeof opts.installation === "string" ? opts.installation : String(res.inputs.installation_id ?? "");
  if (!appId) throw new Error(`${res.name} has no app id. Re-add it with --set app_id=<id>`);
  if (!installationId) throw new Error(`Which installation? Pass --installation <id> or re-add ${res.name} with --set installation_id=<id>`);

  const permissions = Object.fromEntries(
    list(opts.permission).map((p) => {
      const [k, v] = p.split("=");
      if (!k || !v) throw new Error(`--permission expects name=level, e.g. contents=read; got "${p}"`);
      return [k, v];
    }),
  );

  const agent = currentAgent(opts);
  if (agent) await authorize(root, agent, [{ key: keyName, resource: res.name }]);
  const key = await (await openVault(ctx.project, ctx.vault)).get(keyName);
  if (!key) throw new Error(`${keyName} is missing from the ${ctx.vault} vault; add the key again`);

  const t = await installationToken({ appId, installationId, key, repositories: list(opts.repo), permissions });
  await recordUse(ctx.project, { keys: [keyName], via: "github.token", app: to, ...(agent ? { agent } : {}) });
  const scope = Object.entries(t.permissions).map(([k, v]) => `${k}:${v}`).join(", ");
  log({}, `sikrets: GitHub token for installation ${installationId} (${t.repositories} repos${scope ? `; ${scope}` : ""}), expires ${until(t.expiresAt)}`);
  await deliver(Object.fromEntries(GITHUB.tokenEnv.map((name) => [name, t.token])), command);
}
