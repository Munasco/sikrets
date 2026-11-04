import { agents, agentStatus, type Agent } from "../core/agents.ts";
import { sessionSeconds } from "../core/aws-session.ts";
import type { Context } from "../core/plan.ts";
import { state } from "../core/state.ts";
import { until } from "../core/ttl.ts";
import { isCloudVault } from "../core/vault.ts";
import { activeCloud, cloudProvider } from "../cloud/index.ts";
import { log } from "../ui.ts";
import { deliver, recipient } from "./deliver.ts";
import { AGENT_ROLE, AWS_SESSION } from "../constants.ts";

// Agents in your self-hosted Sikrets stack. With a cloud vault, every agent (`sikrets agent add`)
// gets its own cloud identity (AWS: an IAM role under the stack's permissions boundary, tagged
// sikrets:agent) that can read only the vault secrets in its scope, until it expires, plus any
// --allow permissions. It is only ever used through temporary credentials; nobody gets a key for it.
//
// `sikrets agent role <name>` hands those credentials to a command or a shell.

const USAGE = "sikrets agent role";
export const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Vault keys an agent's scope covers: whole resources expand to their keys. */
async function scopedKeys(root: string, scope: readonly string[]): Promise<string[]> {
  const { resources } = await state.load(root);
  const keys = new Set<string>();
  for (const s of scope) {
    if (s === AWS_SESSION.profileScope) continue;
    const r = resources.find((x) => x.name === s);
    for (const k of r ? r.envKeys : [s]) keys.add(k);
  }
  return [...keys];
}

/** Creates or updates the agent's cloud identity for a cloud vault; nothing for other vaults. */
export async function syncAgentIdentity(ctx: Context, agent: Agent, allow: string[]) {
  if (!isCloudVault(ctx.vault)) {
    if (allow.length) throw new Error(`--allow needs a cloud vault (sikrets cloud connect, then "vault": "aws" in sikrets.json)`);
    return undefined;
  }
  const provider = await cloudProvider(ctx.vault);
  return provider.ensureAgentIdentity({
    name: agent.name,
    project: ctx.project,
    keys: await scopedKeys(ctx.root, agent.scope),
    ...(agent.expiresAt ? { expiresAt: agent.expiresAt } : {}),
    ...(allow.length ? { allow } : {}),
  });
}

/** Deletes the agent's cloud identity, if its vault is a cloud one. */
export async function removeAgentIdentity(ctx: Context, name: string): Promise<boolean> {
  if (!isCloudVault(ctx.vault)) return false;
  return (await cloudProvider(ctx.vault)).removeAgentIdentity(name);
}

/** Temporary credentials for reading an agent's secrets from a cloud vault. */
export async function agentVaultCredentials(vault: "aws", agent: string) {
  return (await cloudProvider(vault)).issueCredentials(agent, { seconds: sessionSeconds(AGENT_ROLE.defaultTtl) });
}

export async function run(agent: string, command: string[], opts: Record<string, unknown>) {
  const provider = await activeCloud(typeof opts.provider === "string" ? opts.provider : undefined);
  const profile = typeof opts.profile === "string" ? opts.profile : undefined;

  if (opts.revoke) {
    if (!(await provider.removeAgentIdentity(agent))) throw new Error(`Agent ${agent} has no identity in your ${provider.name} stack`);
    if (opts.json) return console.log(JSON.stringify({ agent, removed: true }));
    return log(opts, `Removed ${agent}'s ${provider.name} identity. Credentials already issued stop working when they expire (at most ${AGENT_ROLE.maxSessionSeconds / 60}m).`);
  }

  // An agent this project revoked, or that expired, gets nothing here either.
  const known = await agents.find(process.cwd(), agent);
  if (known && agentStatus(known) !== "active") throw new Error(`Agent "${agent}" is ${agentStatus(known)}; it gets no credentials`);

  const seconds = sessionSeconds(typeof opts.ttl === "string" ? opts.ttl : AGENT_ROLE.defaultTtl);
  const allow = list(opts.allow);
  // Checked before anything is created, so a refused delivery leaves no identity behind.
  const to = recipient(command, opts, `${USAGE} ${agent}`);
  const identity = await provider.ensureAgentIdentity({ name: agent, ...(allow.length ? { allow } : {}) });
  const creds = await provider.issueCredentials(agent, { seconds, identity, ...(profile ? { profile } : {}) });
  log({}, `sikrets: ${provider.name} credentials for ${agent} as ${creds.identity}${identity.created ? " (new)" : ""}, for ${to}, expire ${until(creds.expiresAt)}`);
  await deliver(creds.env, command);
}
