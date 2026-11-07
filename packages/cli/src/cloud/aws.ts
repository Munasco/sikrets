import { sessionEnv, type AwsCredentials } from "../core/aws-session.ts";
import { ssmParams } from "../core/vault.ts";
import {
  agentCredentials,
  agentRoleArn,
  connectedStack,
  deleteStack,
  deployStack,
  describeAgentRole,
  ensureAgentRole,
  externalId,
  findStack,
  iamClient,
  loadStack,
  parseAllow,
  quickCreateUrl,
  refreshStack,
  removeAgentRole,
  stackClientConfig,
  stackProblem,
  usable,
  vaultStatements,
  type StackState,
} from "./aws-stack.ts";
import type { CloudProvider, Deployment } from "./types.ts";
import { AWS_SESSION, AWS_STACK, SSM_PREFIX } from "../constants.ts";

// AWS: a CloudFormation stack (packages/stack/sikrets.yaml). The secret store is SSM Parameter
// Store under the stack's KMS key, an agent identity is an IAM role under the stack's permissions
// boundary, and temporary credentials come from STS AssumeRole. All of it runs on your own AWS
// credentials (your connected profile, or AWS's default chain).

const region = (r?: string) => r || Bun.env.AWS_REGION || AWS_SESSION.defaultRegion;

/**
 * Runs `fn` against the connected stack. If AWS refuses, checks whether the stack itself is the
 * reason (deleted outside Sikrets, or mid-change), and says that instead of the raw error.
 */
async function onStack<T>(fn: (s: StackState) => Promise<T>): Promise<T> {
  const s = await connectedStack();
  try {
    return await fn(s);
  } catch (e) {
    const now = await refreshStack(s).catch(() => undefined);
    if (now && !usable(now.status)) throw new Error(stackProblem(now));
    throw e;
  }
}

export const aws: CloudProvider = {
  id: "aws",
  name: "AWS",

  connected: async () => (await loadStack()) !== null,

  async status(o = {}) {
    const recorded = await loadStack();
    if (!recorded) return { provider: "aws", status: "not-deployed", hint: "Deploy one: sikrets cloud connect --provider aws" };
    const r = await refreshStack(recorded, o);
    return {
      provider: "aws",
      name: r.stackName,
      status: r.status,
      ...(r.cfnStatus ? { detail: r.cfnStatus } : {}),
      account: r.account,
      region: r.region,
      ...(usable(r.status) ? {} : { hint: stackProblem(r) }),
    };
  },

  async deploy(o) {
    const current = await loadStack();
    const s = await deployStack({
      region: region(o.region ?? current?.region),
      ...(o.profile ? { profile: o.profile } : {}),
      stackName: o.name ?? current?.stackName ?? AWS_STACK.defaultName,
      ...(o.githubRepository !== undefined ? { githubRepository: o.githubRepository } : {}),
      ...(o.githubOidcExists ? { githubProviderExists: true } : {}),
      ...(o.brokerAccount !== undefined ? { trustedAccount: o.brokerAccount } : {}),
      log: o.log,
    });
    const { action, ...details } = s;
    return {
      provider: "aws",
      name: s.stackName,
      account: s.account,
      region: s.region,
      action,
      outputs: [
        ["vault", `${s.vaultPath}<project>/<KEY>, encrypted under ${s.keyArn}`],
        ["boundary", s.boundaryArn],
        ["manager policy", s.managerPolicyArn],
        ["events", `${s.eventBusName} (secret access, agent activity)`],
        ["audit log", s.auditLogGroup],
        ...(s.githubRoleArn ? [["GitHub", `${s.githubRoleArn} (role-to-assume for ${s.githubRepository})`] as [string, string]] : []),
        ...(s.brokerRoleArn ? [["broker", `${s.brokerRoleArn} (from ${s.trustedAccount}, with the external ID)`] as [string, string]] : []),
      ],
      details,
    } satisfies Deployment;
  },

  async deployLink(o) {
    const r = region(o.region);
    const stackName = o.name ?? AWS_STACK.defaultName;
    const broker = o.brokerAccount && o.brokerAccount !== AWS_STACK.noBroker ? o.brokerAccount : "";
    return quickCreateUrl({
      region: r,
      stackName,
      templateUrl: o.templateUrl,
      githubRepository: o.githubRepository ?? "",
      githubProviderExists: Boolean(o.githubOidcExists),
      trustedAccount: broker,
      externalId: broker ? (await externalId(r, stackName)).value : "",
    });
  },

  async teardown(o) {
    const recorded = await loadStack();
    // A stack that isn't recorded here (its first deploy failed elsewhere, say) can be named instead.
    const s =
      o.name && (!recorded || recorded.stackName !== o.name)
        ? await findStack({ stackName: o.name, region: region(o.region ?? recorded?.region), ...(o.profile ? { profile: o.profile } : {}) })
        : recorded;
    if (!s) throw new Error("No Sikrets stack connected here; nothing to disconnect. To remove one by name: sikrets cloud disconnect --stack NAME --yes");
    const { agentRoles, forgotten } = await deleteStack(s, { ...(o.profile ? { profile: o.profile } : {}), log: o.log });
    const kept = forgotten ? [] : [`audit log group ${s.auditLogGroup ?? `for ${s.stackName}`}`, "the trail bucket", "the KMS key, scheduled for deletion in 30 days (cancel that in KMS to read old parameters)"];
    return { name: s.stackName, agentIdentities: agentRoles, kept, forgotten };
  },

  async secretStore(project, o = {}) {
    const s = await connectedStack();
    if (s.vaultPath !== `${SSM_PREFIX}/`) throw new Error(`Stack ${s.stackName} keeps its vault under ${s.vaultPath}, but this CLI uses ${SSM_PREFIX}/`);
    const { SSMClient } = await import("@aws-sdk/client-ssm");
    const credentials = o.as?.handle as AwsCredentials | undefined;
    return ssmParams(project, new SSMClient(credentials ? { region: s.region, credentials } : stackClientConfig(s)), s.keyArn);
  },

  checkAllow: (allow) => void parseAllow(allow),

  ensureAgentIdentity: (g) =>
    onStack(async (s) => {
      const iam = await iamClient(stackClientConfig(s));
      try {
        const vault = g.keys ? vaultStatements(s, g.project, g.keys, g.expiresAt) : undefined;
        const allow = g.allow ? parseAllow(g.allow, g.expiresAt) : undefined;
        const role = await ensureAgentRole(iam, s, { project: g.project, agent: g.name, ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}) }, { ...(vault ? { vault } : {}), ...(allow ? { allow } : {}) });
        return { id: role.arn, created: role.created };
      } finally {
        iam.destroy();
      }
    }),

  async removeAgentIdentity(project, name) {
    const s = await loadStack();
    if (!s) return false;
    // A stack that's gone took its roles with it: nothing left to remove.
    const live = usable(s.status) ? s : await refreshStack(s).catch(() => s);
    if (live.status === "deleted-outside" || live.status === "not-deployed") return false;
    if (!usable(live.status)) throw new Error(stackProblem(live));
    const iam = await iamClient(stackClientConfig(live as StackState));
    try {
      return await removeAgentRole(iam, live as StackState, project, name);
    } finally {
      iam.destroy();
    }
  },

  describeAgentIdentity: (project, name) =>
    onStack(async (s) => {
      const iam = await iamClient(stackClientConfig(s));
      try {
        const r = await describeAgentRole(iam, project, name);
        return r ? { id: r.arn, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}) } : undefined;
      } finally {
        iam.destroy();
      }
    }),

  issueCredentials: (project, agent, o) =>
    onStack(async (s) => {
      const creds = await agentCredentials(s, { project, agent, seconds: o.seconds, ...(o.identity ? { roleArn: o.identity.id, fresh: o.identity.created } : {}), ...(o.profile ? { profile: o.profile } : {}) });
      const role = o.identity?.id ?? agentRoleArn(s, project, agent);
      const session = sessionEnv(creds, s.region, role);
      return { env: session.env, expiresAt: session.expiresAt, identity: role, handle: creds };
    }),
};
