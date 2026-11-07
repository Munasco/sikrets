import { agents, agentStatus, checkAgentName } from "../core/agents.ts";
import { projectContext } from "../core/config.ts";
import { isCloudVault } from "../core/vault.ts";
import { state } from "../core/state.ts";
import { after, until } from "../core/ttl.ts";
import { log } from "../ui.ts";
import { AWS_SESSION } from "../constants.ts";

// `sikrets agent add|list|revoke`: scoped identities for agents. An agent is handed only the keys
// in its scope, only until it expires, and nothing once revoked (see core/agents.ts).
// With a cloud vault each agent also gets its own cloud identity; `sikrets agent role` hands out
// its temporary credentials (agent-role.ts).

const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const [sub = "list", name] = args;
  if (sub === "role") {
    if (!name) throw new Error("Usage: sikrets agent role <name> --allow ACTION=RESOURCE [--ttl 15m] (--env | -- <command>)");
    return (await import("./agent-role.ts")).run(checkAgentName(name), args.slice(2), opts);
  }
  const all = await agents.load(root);

  if (sub === "list" || sub === "ls") {
    const rows = all.map((a) => ({ ...a, status: agentStatus(a) }));
    if (opts.json) return console.log(JSON.stringify(rows));
    if (!rows.length) return console.log("No agents yet. Add one: sikrets agent add <name> --key <resource>");
    const w = Math.max(...rows.map((r) => r.name.length), 4);
    for (const r of rows) {
      const when = r.status === "revoked" && "revokedAt" in r ? `revoked ${r.revokedAt.slice(0, 10)}` : r.expiresAt ? (r.status === "expired" ? "expired" : `expires ${until(r.expiresAt)}`) : "no expiry";
      console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(8)} ${when.padEnd(18)} ${r.scope.join(", ")}`);
    }
    return;
  }

  if (!name) throw new Error(`Usage: sikrets agent ${sub} <name>`);
  checkAgentName(name);

  if (sub === "add") {
    const scope = list(opts.key);
    if (!scope.length) throw new Error(`Give ${name} at least one key: sikrets agent add ${name} --key <resource or KEY_NAME>`);
    const { resources } = await state.load(root);
    const known = new Set([AWS_SESSION.profileScope, ...resources.flatMap((r) => [r.name, ...r.envKeys])]);
    const unknown = scope.filter((s) => !known.has(s));
    if (unknown.length) throw new Error(`Not in this project: ${unknown.join(", ")}. Use resource names or key names (see sikrets inventory)`);
    const { ctx } = await projectContext(root, { log: () => {} });
    const cloud = isCloudVault(ctx.vault);
    const allow = list(opts.allow);
    if (!cloud && allow.length) throw new Error(`--allow needs a cloud vault (sikrets cloud connect, then "vault": "aws" in sikrets.json)`);
    if (cloud) (await (await import("../cloud/index.ts")).cloudProvider(ctx.vault)).checkAllow(allow);
    // Checked again under the lock: active names are refused, revoked names stay revoked. With a cloud
    // vault the record is written first (identity pending), so a failure creating the identity leaves
    // something the next `agent add` resumes, never a role nobody knows about.
    const added = await agents.add(root, { name, scope, ...(typeof opts.expires === "string" ? { expiresAt: after(opts.expires) } : {}), cloud });
    const { agent, role } = cloud ? await (await import("./agent-role.ts")).provisionIdentity(ctx, added, allow) : { agent: added, role: undefined };
    if (opts.json) return console.log(JSON.stringify({ ...agent, ...(role ? { identity: role.id } : {}) }));
    return log(
      opts,
      `Added agent ${name}: ${scope.join(", ")}${agent.expiresAt ? `, expires ${until(agent.expiresAt)}` : ""}${role ? `, identity ${role.id}` : ""}. Use it with: sikrets run --agent ${name} -- <command>`,
    );
  }

  if (sub === "revoke") {
    const { ctx } = await projectContext(root, { log: () => {} });
    const { agent, already, identityRemoved } = await (await import("./agent-role.ts")).revokeAgent(ctx, name);
    if (opts.json) return console.log(JSON.stringify({ ...agent, ...(identityRemoved ? { identityRemoved } : {}) }));
    if (already && !identityRemoved && agent.status === "revoked") return log(opts, `${name} was already revoked at ${agent.revokedAt}.`);
    return log(opts, `Revoked ${name}${identityRemoved ? " and removed its cloud identity" : ""}; other agents are unaffected. To replace the keys it saw: sikrets offboard ${name}`);
  }

  throw new Error(`Unknown agent subcommand "${sub}". Use: sikrets agent add|list|revoke|role <name>`);
}
