import { authorize, currentAgent, leaseSeconds } from "../core/agents.ts";
import { awsSession, sessionSeconds } from "../core/aws-session.ts";
import { projectContext } from "../core/config.ts";
import { state, type Resource } from "../core/state.ts";
import { until } from "../core/ttl.ts";
import { recordUse } from "../core/usage.ts";
import { openVault } from "../core/vault.ts";
import { awsProfile } from "../providers/aws.ts";
import { log } from "../ui.ts";
import { deliver, recipient } from "./deliver.ts";
import { AWS_SESSION } from "../constants.ts";

// `sikrets aws session`: 15–60 minute AWS credentials from a long-lived key, for a command or a
// shell. The long-lived key never leaves Sikrets; only the temporary set is handed out.

const USAGE = "sikrets aws session";

/** The stored aws/access-key to use: --key, else the only one in the project, else none (use the profile). */
function storedKey(resources: readonly Resource[], name: unknown): Resource | undefined {
  const keys = resources.filter((r) => r.applied && r.recipe === "aws/access-key");
  if (typeof name === "string") {
    const r = keys.find((k) => k.name === name);
    if (!r) throw new Error(`No aws/access-key named "${name}" in this project. Add one: sikrets add aws/access-key --name ${name}`);
    return r;
  }
  if (keys.length > 1) throw new Error(`Several AWS keys here (${keys.map((k) => k.name).join(", ")}); pick one with --key`);
  return keys[0];
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const [sub, ...command] = args;
  if (sub !== "session") throw new Error(`Usage: ${USAGE} [--role ARN] [--for 30m] (--env | -- <command>)`);
  const root = process.cwd();
  const wanted = sessionSeconds(typeof opts.for === "string" ? opts.for : AWS_SESSION.defaultDuration);
  const to = recipient(command, opts, USAGE);
  const { ctx } = await projectContext(root, { log: () => {} });
  const res = storedKey((await state.load(root)).resources, opts.key);
  const keyName = res?.envKeys[0];
  const profile = res ? undefined : await awsProfile();
  // Usage log entry: the stored key's name, or which profile issued the session.
  const used = keyName ?? `${AWS_SESSION.profileScope}:${profile ?? "default"}`;

  const agent = currentAgent(opts);
  const grant = agent ? await authorize(root, agent, [res ? { key: keyName!, resource: res.name } : { key: used, resource: AWS_SESSION.profileScope }]) : undefined;
  // An agent's session never outlives the agent.
  const seconds = leaseSeconds(grant?.agent, wanted, AWS_SESSION.minMinutes * 60);
  const key = res ? await (await openVault(ctx.project, ctx.vault)).get(keyName!) : undefined;
  if (res && !key) throw new Error(`${keyName} is missing from the ${ctx.vault} vault; add the key again`);

  const region = typeof opts.region === "string" ? opts.region : Bun.env.AWS_REGION || AWS_SESSION.defaultRegion;
  const session = await awsSession({ ...(key ? { key } : {}), ...(profile ? { profile } : {}), region, seconds, ...(typeof opts.role === "string" ? { role: opts.role } : {}) });
  await recordUse(ctx.project, { keys: [used], via: "aws.session", app: to, ...(agent ? { agent } : {}) });
  log({}, `sikrets: AWS session${session.role ? ` as ${session.role}` : ""} from ${res ? res.name : `profile ${profile ?? "default"}`}, expires ${until(session.expiresAt)}`);
  await deliver(session.env, command);
}
