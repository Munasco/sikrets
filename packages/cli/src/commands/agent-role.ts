import { agents, agentStatus, leaseSeconds, type Agent } from "../core/agents.ts";
import { projectContext } from "../core/config.ts";
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

/**
 * Finishes an agent's cloud identity: the record says pending (written before any cloud call), the
 * identity is created or updated, then the record says ready. Re-running after a failure resumes.
 */
export async function provisionIdentity(ctx: Context, agent: Agent, allow: string[]) {
  const role = await syncAgentIdentity(ctx, agent, allow);
  if (!role) return { agent, role };
  return { agent: await agents.setIdentity(ctx.root, agent.id, "ready", role.id), role };
}

/**
 * Revokes an agent. Locally first, in one write: revoked (so the CLI hands it nothing more) and,
 * with a cloud vault, its identity marked removing. Then the cloud identity is deleted and marked
 * removed. Idempotent: a re-run after a failure keeps deleting until the identity is gone.
 */
export async function revokeAgent(ctx: Context, name: string) {
  const cloud = isCloudVault(ctx.vault);
  let { agent, already } = await agents.revoke(ctx.root, name, { cloud });
  let identityRemoved = false;
  if (cloud && agent.cloudIdentity?.status !== "removed") {
    if (agent.cloudIdentity?.status !== "removing") agent = await agents.setIdentity(ctx.root, agent.id, "removing"); // revoked before this was tracked
    identityRemoved = await (await cloudProvider(ctx.vault)).removeAgentIdentity(ctx.project, name);
    agent = await agents.setIdentity(ctx.root, agent.id, "removed");
  }
  return { agent, already, identityRemoved };
}

/** Temporary credentials for reading an agent's secrets from a cloud vault, never outliving the agent. */
export async function agentVaultCredentials(ctx: Context & { vault: "aws" }, agent: Agent) {
  const status = agent.cloudIdentity?.status;
  if (status === "removing" || status === "removed") throw new Error(`Agent "${agent.name}"'s cloud identity is ${status}; it gets no credentials`);
  // An add that stopped before its identity was confirmed, or a record from before identities were
  // per project: create (or take over) the identity now, from the scope on record.
  const ready = status === "ready" ? agent : (await provisionIdentity(ctx, agent, [])).agent;
  const seconds = leaseSeconds(ready, sessionSeconds(AGENT_ROLE.defaultTtl), AWS_SESSION.minMinutes * 60);
  return (await cloudProvider(ctx.vault)).issueCredentials(ctx.project, agent.name, { seconds });
}

export async function run(agent: string, command: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const { ctx } = await projectContext(root, { log: () => {} });
  const provider = await activeCloud(typeof opts.provider === "string" ? opts.provider : undefined);
  const profile = typeof opts.profile === "string" ? opts.profile : undefined;
  const known = await agents.find(root, agent);

  if (opts.revoke) {
    // An agent this project knows is revoked the whole way, so agents.json never says active for a deleted role.
    if (known && isCloudVault(ctx.vault)) {
      const r = await revokeAgent(ctx, agent);
      if (opts.json) return console.log(JSON.stringify({ agent, removed: r.identityRemoved, revoked: true }));
      return log(opts, `Revoked ${agent} and removed its ${provider.name} identity. Credentials already issued stop working when they expire (at most ${AGENT_ROLE.maxSessionSeconds / 60}m).`);
    }
    if (!(await provider.removeAgentIdentity(ctx.project, agent))) throw new Error(`Agent ${agent} has no identity in your ${provider.name} stack for project ${ctx.project}`);
    if (opts.json) return console.log(JSON.stringify({ agent, removed: true }));
    return log(opts, `Removed ${agent}'s ${provider.name} identity. Credentials already issued stop working when they expire (at most ${AGENT_ROLE.maxSessionSeconds / 60}m).`);
  }

  const ttl = sessionSeconds(typeof opts.ttl === "string" ? opts.ttl : AGENT_ROLE.defaultTtl);
  const allow = list(opts.allow);
  provider.checkAllow(allow);
  // Checked before anything is created, so a refused delivery leaves no identity behind.
  const to = recipient(command, opts, `${USAGE} ${agent}`);

  // An agent this project revoked, or that expired, gets nothing here either. One that isn't in this
  // project's agents.json is checked against what its identity records (its expiry tag).
  if (known && agentStatus(known) !== "active") throw new Error(`Agent "${agent}" is ${agentStatus(known)}; it gets no credentials`);
  const s = known?.cloudIdentity?.status;
  if (s === "removing" || s === "removed") throw new Error(`Agent "${agent}"'s cloud identity is ${s}; it gets no credentials`);
  const expiresAt = known ? known.expiresAt : (await provider.describeAgentIdentity(ctx.project, agent))?.expiresAt;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error(`Agent "${agent}" expired at ${expiresAt}; it gets no credentials`);
  const seconds = leaseSeconds({ name: agent, ...(expiresAt ? { expiresAt } : {}) }, ttl, AWS_SESSION.minMinutes * 60);

  const identity = await provider.ensureAgentIdentity({ name: agent, project: ctx.project, ...(expiresAt ? { expiresAt } : {}), ...(allow.length ? { allow } : {}) });
  const creds = await provider.issueCredentials(ctx.project, agent, { seconds, identity, ...(profile ? { profile } : {}) });
  log({}, `sikrets: ${provider.name} credentials for ${agent} as ${creds.identity}${identity.created ? " (new)" : ""}, for ${to}, expire ${until(creds.expiresAt)}`);
  await deliver(creds.env, command);
}
