import { agents, agentStatus } from "../core/agents.ts";
import { projectContext } from "../core/config.ts";
import { state } from "../core/state.ts";
import { readUsage, touchedBy } from "../core/usage.ts";
import { confirm, log } from "../ui.ts";
import { run as rotate } from "./rotate.ts";

// `sikrets offboard <person-or-agent>`: everyone leaves eventually. Lists every key the person (OS
// user) or agent was handed, from the local usage log, revokes the agent if it is one, then
// rotates each affected resource one at a time with `sikrets rotate`, asking before each.

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const who = args[0]!;
  const say = (m: string) => log(opts, m);
  const dryRun = Boolean(opts["dry-run"]);
  const { ctx } = await projectContext(root, { log: say });
  const keys = touchedBy(await readUsage(ctx.project), who);
  const agent = await agents.find(root, who);
  const { resources } = await state.load(root);

  // Several keys can belong to one resource; rotation is per resource.
  const owner = (key: string) => resources.find((r) => r.applied && r.envKeys.includes(key));
  const targets = [...new Set(keys.map(owner).filter((r) => r !== undefined))];
  const gone = keys.filter((k) => !owner(k));

  if (!keys.length && !agent) throw new Error(`Nothing recorded for "${who}": no agent by that name and no keys handed to them in this project`);
  say(`${dryRun ? "Dry run — would offboard" : "Offboarding"} ${agent ? `agent ${who}` : who}:`);
  if (agent && agentStatus(agent) !== "revoked") say(`  ~ Revoke agent ${who}`);
  for (const r of targets) say(`  ~ Rotate ${r.name} (${r.envKeys.filter((k) => keys.includes(k)).join(", ")})`);
  for (const k of gone) say(`  · ${k} isn't stored in this project any more; replace it where it lives`);
  if (!targets.length) say("  No stored keys to rotate.");

  const result = { who, agent: Boolean(agent), keys, rotate: targets.map((r) => r.name), rotated: [] as string[], skipped: [] as string[], failed: [] as { resource: string; error: string }[] };
  if (dryRun) return opts.json ? console.log(JSON.stringify({ dryRun: true, ...result })) : undefined;
  if (!opts.yes && !process.stdin.isTTY) throw new Error("No terminal to confirm each rotation in; pass --yes to rotate them all");

  if (agent && agentStatus(agent) !== "revoked") {
    const all = await agents.load(root);
    await agents.save(root, all.map((a) => (a.name === who ? { ...a, revokedAt: new Date().toISOString() } : a)));
    say(`Revoked agent ${who}.`);
  }
  for (const r of targets) {
    if (!opts.yes && !(await confirm(`Rotate ${r.name}? Its current credential will stop working.`))) {
      result.skipped.push(r.name);
      continue;
    }
    try {
      await rotate([r.name], { yes: true });
      result.rotated.push(r.name);
    } catch (error) {
      // One failure (say, a Terraform-managed key) shouldn't stop the rest.
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ resource: r.name, error: message });
      say(`  ✗ ${r.name}: ${message}`);
    }
  }
  if (result.failed.length) process.exitCode = 1;
  if (opts.json) return console.log(JSON.stringify(result));
  say(`Offboarded ${who}: ${result.rotated.length} rotated, ${result.skipped.length} skipped, ${result.failed.length} failed.`);
}
