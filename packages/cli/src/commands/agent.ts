import { agents, agentStatus, checkAgentName, type Agent } from "../core/agents.ts";
import { state } from "../core/state.ts";
import { after, until } from "../core/ttl.ts";
import { log } from "../ui.ts";
import { AWS_SESSION } from "../constants.ts";

// `sikrets agent add|list|revoke`: scoped identities for agents. An agent is handed only the keys
// in its scope, only until it expires, and nothing once revoked (see core/agents.ts).
// `sikrets agent role`: an IAM role for the agent in your Sikrets AWS stack (agent-role.ts).

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
      const when = r.status === "revoked" ? `revoked ${r.revokedAt!.slice(0, 10)}` : r.expiresAt ? (r.status === "expired" ? "expired" : `expires ${until(r.expiresAt)}`) : "no expiry";
      console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(8)} ${when.padEnd(18)} ${r.scope.join(", ")}`);
    }
    return;
  }

  if (!name) throw new Error(`Usage: sikrets agent ${sub} <name>`);
  checkAgentName(name);
  const existing = all.find((a) => a.name === name);

  if (sub === "add") {
    if (existing && agentStatus(existing) === "active") throw new Error(`Agent "${name}" already exists. Revoke it first to change its scope`);
    const scope = list(opts.key);
    if (!scope.length) throw new Error(`Give ${name} at least one key: sikrets agent add ${name} --key <resource or KEY_NAME>`);
    const { resources } = await state.load(root);
    const known = new Set([AWS_SESSION.profileScope, ...resources.flatMap((r) => [r.name, ...r.envKeys])]);
    const unknown = scope.filter((s) => !known.has(s));
    if (unknown.length) throw new Error(`Not in this project: ${unknown.join(", ")}. Use resource names or key names (see sikrets inventory)`);
    const agent: Agent = { name, scope, createdAt: new Date().toISOString(), ...(typeof opts.expires === "string" ? { expiresAt: after(opts.expires) } : {}) };
    await agents.save(root, all.filter((a) => a.name !== name).concat(agent));
    if (opts.json) return console.log(JSON.stringify(agent));
    return log(opts, `Added agent ${name}: ${scope.join(", ")}${agent.expiresAt ? `, expires ${until(agent.expiresAt)}` : ""}. Use it with: sikrets run --agent ${name} -- <command>`);
  }

  if (sub === "revoke") {
    if (!existing) throw new Error(`No agent named "${name}"`);
    if (existing.revokedAt) return log(opts, `${name} was already revoked at ${existing.revokedAt}.`);
    const revoked = { ...existing, revokedAt: new Date().toISOString() };
    await agents.save(root, all.map((a) => (a.name === name ? revoked : a)));
    if (opts.json) return console.log(JSON.stringify(revoked));
    return log(opts, `Revoked ${name}; other agents are unaffected. To replace the keys it saw: sikrets offboard ${name}`);
  }

  throw new Error(`Unknown agent subcommand "${sub}". Use: sikrets agent add|list|revoke|role <name>`);
}
