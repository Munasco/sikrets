import { sessionEnv, type AwsCredentials } from "../core/aws-session.ts";
import { ssmParams } from "../core/vault.ts";
import {
  agentCredentials,
  agentRoleName,
  connectedStack,
  deleteAgentRole,
  deleteStack,
  deployStack,
  ensureAgentRole,
  externalId,
  iamClient,
  loadStack,
  parseAllow,
  quickCreateUrl,
  stackClientConfig,
  vaultStatements,
} from "./aws-stack.ts";
import type { CloudProvider, Deployment } from "./types.ts";
import { AGENT_ROLE, AWS_SESSION, AWS_STACK, SSM_PREFIX } from "../constants.ts";

// AWS: a CloudFormation stack (packages/stack/sikrets.yaml). The secret store is SSM Parameter
// Store under the stack's KMS key, an agent identity is an IAM role under the stack's permissions
// boundary, and temporary credentials come from STS AssumeRole. All of it runs on your own AWS
// credentials (your connected profile, or AWS's default chain).

const region = (r?: string) => r || Bun.env.AWS_REGION || AWS_SESSION.defaultRegion;

export const aws: CloudProvider = {
  id: "aws",
  name: "AWS",

  connected: async () => (await loadStack()) !== null,

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
    const s = await connectedStack();
    const { agentRoles } = await deleteStack(s, { ...(o.profile ? { profile: o.profile } : {}), log: o.log });
    return { name: s.stackName, agentIdentities: agentRoles, kept: [`audit log group ${s.auditLogGroup}`, "the trail bucket", "the KMS key, scheduled for deletion in 30 days (cancel that in KMS to read old parameters)"] };
  },

  async secretStore(project, o = {}) {
    const s = await connectedStack();
    if (s.vaultPath !== `${SSM_PREFIX}/`) throw new Error(`Stack ${s.stackName} keeps its vault under ${s.vaultPath}, but this CLI uses ${SSM_PREFIX}/`);
    const { SSMClient } = await import("@aws-sdk/client-ssm");
    const credentials = o.as?.handle as AwsCredentials | undefined;
    return ssmParams(project, new SSMClient(credentials ? { region: s.region, credentials } : stackClientConfig(s)), s.keyArn);
  },

  async ensureAgentIdentity(g) {
    const s = await connectedStack();
    const iam = await iamClient(stackClientConfig(s));
    try {
      const vault = g.keys && g.project ? vaultStatements(s, g.project, g.keys, g.expiresAt) : undefined;
      const allow = g.allow ? parseAllow(g.allow) : undefined;
      const role = await ensureAgentRole(iam, s, g.name, { ...(vault ? { vault } : {}), ...(allow ? { allow } : {}) });
      return { id: role.arn, created: role.created };
    } finally {
      iam.destroy();
    }
  },

  async removeAgentIdentity(name) {
    const s = await loadStack();
    if (!s) return false;
    const iam = await iamClient(stackClientConfig(s));
    try {
      // The stack owns the GitHub Actions role; only what Sikrets granted it is removed.
      return await deleteAgentRole(iam, agentRoleName(name), { keepRole: name === AGENT_ROLE.githubAgent && Boolean(s.githubRoleArn) });
    } finally {
      iam.destroy();
    }
  },

  async issueCredentials(agent, o) {
    const s = await connectedStack();
    const creds = await agentCredentials(s, { agent, seconds: o.seconds, ...(o.identity ? { roleArn: o.identity.id, fresh: o.identity.created } : {}), ...(o.profile ? { profile: o.profile } : {}) });
    const role = o.identity?.id ?? `arn:${s.keyArn.split(":")[1]}:iam::${s.account}:role${s.agentRolePath}${agentRoleName(agent)}`;
    const session = sessionEnv(creds, s.region, role);
    return { env: session.env, expiresAt: session.expiresAt, identity: role, handle: creds };
  },
};
