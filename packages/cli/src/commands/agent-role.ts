import { agentCredentials, agentRoleName, brokerSession, connectedStack, deleteAgentRole, ensureAgentRole, iamClient, parseAllow } from "../core/aws-stack.ts";
import { sessionEnv, sessionSeconds } from "../core/aws-session.ts";
import { until } from "../core/ttl.ts";
import { awsProfile } from "../providers/aws.ts";
import { log } from "../ui.ts";
import { deliver, recipient } from "./deliver.ts";
import { AGENT_ROLE } from "../constants.ts";

// `sikrets agent role <name>`: an IAM role for one agent in your Sikrets stack, created as the broker
// so it always carries the stack's permissions boundary and the sikrets:agent tag. The agent only
// ever gets temporary credentials for it (AssumeRole, 15 to 60 minutes), never a long-lived key.

const USAGE = "sikrets agent role";
const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export async function run(agent: string, command: string[], opts: Record<string, unknown>) {
  const stack = await connectedStack();
  const profile = (typeof opts.profile === "string" ? opts.profile : undefined) ?? stack.profile ?? (await awsProfile());

  if (opts.revoke) {
    const iam = await iamClient(await brokerSession(stack, profile), stack.region);
    try {
      await deleteAgentRole(iam, agentRoleName(agent));
    } finally {
      iam.destroy();
    }
    if (opts.json) return console.log(JSON.stringify({ agent, deleted: agentRoleName(agent) }));
    return log(opts, `Deleted the role for ${agent}. Credentials already issued stop working when they expire (at most ${AGENT_ROLE.maxSessionSeconds / 60}m).`);
  }

  const seconds = sessionSeconds(typeof opts.ttl === "string" ? opts.ttl : AGENT_ROLE.defaultTtl);
  const allow = list(opts.allow);
  const statements = allow.length ? parseAllow(allow) : undefined;
  // Checked before anything is created, so a refused delivery leaves no role behind.
  const to = recipient(command, opts, `${USAGE} ${agent}`);

  const broker = await brokerSession(stack, profile);
  const iam = await iamClient(broker, stack.region);
  let role: Awaited<ReturnType<typeof ensureAgentRole>>;
  try {
    role = await ensureAgentRole(iam, stack, agent, statements);
  } finally {
    iam.destroy();
  }
  const creds = await agentCredentials(broker, { region: stack.region, roleArn: role.arn, agent, seconds, fresh: role.created });
  const session = sessionEnv(creds, stack.region, role.arn);
  log({}, `sikrets: AWS credentials for ${agent} as ${role.arn}${role.created ? " (new role)" : ""}, for ${to}, expire ${until(session.expiresAt)}`);
  await deliver(session.env, command);
}
