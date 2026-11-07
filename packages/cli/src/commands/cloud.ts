import { activeCloud, cloudProvider } from "../cloud/index.ts";
import type { DeployOptions } from "../cloud/types.ts";
import { awsProfile } from "../providers/aws.ts";
import { confirm, log } from "../ui.ts";
import { AWS_STACK, CLOUD, ENV } from "../constants.ts";

// `sikrets cloud connect --provider aws`: deploy (or update) the Sikrets stack in your own cloud
// account with your local credentials, wait for it, and record its outputs. `--link` prints a
// console link that deploys it instead. `sikrets cloud status` asks the cloud where the stack is
// now. `sikrets cloud disconnect` removes it, in any state but mid-change (`--stack NAME` for one
// not recorded here). `sikrets aws connect|disconnect|status` is the same with --provider aws.

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export async function run(args: string[], opts: Record<string, unknown>) {
  const [sub] = args;
  if (sub !== "connect" && sub !== "disconnect" && sub !== "status") throw new Error("Usage: sikrets cloud connect|status|disconnect --provider aws");
  const say = (m: string) => log(opts, m);
  const id = str(opts.provider);
  const profile = str(opts.profile) || (id === undefined || id === "aws" ? await awsProfile() : undefined);

  if (sub === "connect") {
    const provider = await cloudProvider(id ?? CLOUD.defaultProvider);
    const broker = str(opts["broker-account"]);
    if (broker !== undefined && broker !== AWS_STACK.noBroker && !/^\d{12}$/.test(broker)) {
      throw new Error(`--broker-account must be a 12-digit account ID (or "${AWS_STACK.noBroker}" to remove the broker)`);
    }
    const repo = str(opts["github-repo"]);
    if (repo !== undefined && repo !== "" && !/^[\w.-]+\/[\w.*-]+$/.test(repo)) throw new Error("--github-repo must be owner/repo");
    const o: DeployOptions = {
      ...(str(opts.region) ? { region: str(opts.region)! } : {}),
      ...(profile ? { profile } : {}),
      ...(str(opts.stack) ? { name: str(opts.stack)! } : {}),
      ...(repo !== undefined ? { githubRepository: repo } : {}),
      ...(opts["github-oidc-exists"] ? { githubOidcExists: true } : {}),
      ...(broker !== undefined ? { brokerAccount: broker } : {}),
      log: say,
    };

    if (opts.link) {
      const templateUrl = str(opts["template-url"]) || Bun.env[ENV.stackTemplateUrl] || AWS_STACK.templateUrl;
      const url = await provider.deployLink({ ...o, templateUrl });
      if (opts.json) return console.log(JSON.stringify({ provider: provider.id, url }));
      console.log(url);
      return say(`Open the link in the ${provider.name} account that should hold the stack and create it. Then run: sikrets cloud connect --provider ${provider.id}${o.region ? ` --region ${o.region}` : ""}`);
    }

    const d = await provider.deploy(o);
    if (opts.json) return console.log(JSON.stringify({ provider: d.provider, action: d.action, ...d.details }));
    const width = Math.max(...d.outputs.map(([k]) => k.length));
    return say(
      [
        `Stack ${d.name} ${d.action} in ${provider.name} account ${d.account} (${d.region}).`,
        ...d.outputs.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
        `Use it for a project: set "vault": "${d.provider}" in sikrets.json. Each agent you add then gets its own identity: sikrets agent add <name> --key <resource>`,
      ].join("\n"),
    );
  }

  if (sub === "status") {
    const provider = await cloudProvider(id ?? CLOUD.defaultProvider);
    const st = await provider.status(profile ? { profile } : {});
    if (opts.json) return console.log(JSON.stringify(st));
    if (!st.name) return say(`No Sikrets stack connected. ${st.hint ?? ""}`.trim());
    return say([`Stack ${st.name} in ${provider.name} account ${st.account} (${st.region}): ${st.status}${st.detail ? ` (${st.detail})` : ""}.`, ...(st.hint ? [st.hint] : [])].join("\n"));
  }

  const name = str(opts.stack);
  // Any recorded stack, usable or not (a failed create included); or one named with --stack.
  const provider = name ? await cloudProvider(id ?? CLOUD.defaultProvider) : await activeCloud(id).catch(() => undefined);
  if (!provider || (!name && !(await provider.connected()))) throw new Error("No Sikrets stack connected here; nothing to disconnect. To remove one by name: sikrets cloud disconnect --stack NAME --yes");
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error("Deleting the stack deletes its vault key and every agent identity; pass --yes to confirm");
    if (!(await confirm(`Delete the Sikrets stack in ${provider.name}, its vault key and every agent identity?`))) return say("Cancelled.");
  }
  const t = await provider.teardown({ ...(profile ? { profile } : {}), ...(name ? { name } : {}), ...(str(opts.region) ? { region: str(opts.region)! } : {}), log: say });
  if (opts.json) return console.log(JSON.stringify({ provider: provider.id, deleted: t.name, agentIdentities: t.agentIdentities, ...(t.forgotten ? { forgotten: true } : {}) }));
  if (t.forgotten) return say(`Stack ${t.name} no longer exists in ${provider.name}; forgot it here.`);
  say(
    [
      `Deleted stack ${t.name} and ${t.agentIdentities.length} agent identit${t.agentIdentities.length === 1 ? "y" : "ies"}.`,
      `Kept for your records: ${t.kept.join("; ")}.`,
    ].join("\n"),
  );
}
