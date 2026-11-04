import path from "node:path";
import template from "../../../stack/sikrets.yaml" with { type: "text" };
import { configDir, keychain } from "../store.ts";
import { readJson, remove, writePrivate } from "./fs.ts";
import { stsCredentials, type AwsCredentials } from "./aws-session.ts";
import { AGENT_ROLE, AWS_STACK, MANAGED_BY_TAG } from "../constants.ts";

// The Sikrets stack in your own AWS account (packages/stack/sikrets.yaml): a broker role Sikrets
// assumes with an external ID, a KMS key only the broker can use, a permissions boundary every agent
// role carries, and an audit log. `connect` deploys it with your local AWS credentials; agent roles
// are then created and assumed *as the broker*, so IAM itself enforces the boundary.

export const TEMPLATE: string = template;

/** What `connect` records about the stack. No secrets: the external ID lives in the keychain. */
export interface StackState {
  stackName: string;
  stackId: string;
  region: string;
  account: string;
  trustedAccount: string;
  profile?: string;
  brokerRoleArn: string;
  keyArn: string;
  boundaryArn: string;
  agentRolePath: string;
  auditLogGroup: string;
  connectedAt: string;
}

export interface AwsTarget {
  region: string;
  profile?: string;
}

type Log = (message: string) => void;

const stateFile = () => path.join(configDir(), AWS_STACK.stateFile);
export const loadStack = () => readJson<StackState | null>(stateFile(), null);
const saveStack = (s: StackState) => writePrivate(stateFile(), JSON.stringify(s, null, 2) + "\n");

export async function connectedStack(): Promise<StackState> {
  const s = await loadStack();
  if (!s) throw new Error("No Sikrets stack connected. Deploy one to your AWS account: sikrets aws connect");
  return s;
}

const auth = (t: AwsTarget) => ({ region: t.region, ...(t.profile ? { profile: t.profile } : {}) });
const errorName = (e: unknown) => (e as { name?: string })?.name ?? "";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── External ID ────────────────────────────────────────────────────────────

const externalIdKey = (region: string, stackName: string) => AWS_STACK.externalIdAccount(region, stackName);

function newExternalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(AWS_STACK.externalIdBytes));
  return Buffer.from(bytes).toString("base64url");
}

/** The stack's external ID from the keychain, minted (and saved) on first use. */
export async function externalId(region: string, stackName: string): Promise<{ value: string; minted: boolean }> {
  const stored = await keychain.get("aws", externalIdKey(region, stackName));
  if (stored) return { value: stored, minted: false };
  const value = newExternalId();
  await keychain.set("aws", externalIdKey(region, stackName), value);
  return { value, minted: true };
}

// ── Stack ─────────────────────────────────────────────────────────────────

export async function callerAccount(t: AwsTarget): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const client = new STSClient(auth(t));
  try {
    const who = await client.send(new GetCallerIdentityCommand({}));
    if (!who.Account) throw new Error("STS did not return an account");
    return who.Account;
  } finally {
    client.destroy();
  }
}

export function stackParameters(o: { trustedAccount: string; externalId: string }) {
  return {
    [AWS_STACK.params.trustedAccount]: o.trustedAccount,
    [AWS_STACK.params.externalId]: o.externalId,
    [AWS_STACK.params.agentRolePath]: AGENT_ROLE.path,
  };
}

/** A CloudFormation console link that creates the stack with its parameters filled in. */
export function quickCreateUrl(o: { region: string; stackName: string; templateUrl: string; trustedAccount: string; externalId: string }) {
  const q = new URLSearchParams({ templateURL: o.templateUrl, stackName: o.stackName });
  for (const [k, v] of Object.entries(stackParameters(o))) q.set(`param_${k}`, v);
  return `${AWS_STACK.quickCreate(o.region)}?${q}`;
}

const isMissingStack = (e: unknown) => errorName(e) === "ValidationError" && /does not exist/i.test(errorText(e));
const isNoop = (e: unknown) => errorName(e) === "ValidationError" && /no updates are to be performed/i.test(errorText(e));

type Cfn = InstanceType<typeof import("@aws-sdk/client-cloudformation").CloudFormationClient>;

async function describe(cfn: Cfn, stack: string) {
  const { DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
  try {
    return (await cfn.send(new DescribeStacksCommand({ StackName: stack }))).Stacks?.[0];
  } catch (e) {
    if (isMissingStack(e)) return undefined;
    throw e;
  }
}

/** Polls until the stack leaves *_IN_PROGRESS; returns its final status (or DELETE_COMPLETE once it's gone). */
async function settle(cfn: Cfn, stack: string, o: { pollMs: number; timeoutMs: number; log: Log }) {
  const deadline = Date.now() + o.timeoutMs;
  let last = "";
  for (;;) {
    const s = await describe(cfn, stack);
    const status = s?.StackStatus ?? "DELETE_COMPLETE";
    if (status !== last) o.log(`  ${status}`);
    last = status;
    if (!status.endsWith("_IN_PROGRESS")) return s;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for stack ${stack} (still ${status})`);
    await Bun.sleep(o.pollMs);
  }
}

async function failureReasons(cfn: Cfn, stack: string): Promise<string> {
  const { DescribeStackEventsCommand } = await import("@aws-sdk/client-cloudformation");
  const events = (await cfn.send(new DescribeStackEventsCommand({ StackName: stack }))).StackEvents ?? [];
  return events
    .filter((e) => e.ResourceStatus?.endsWith("_FAILED") && e.ResourceStatusReason)
    .slice(0, 3)
    .map((e) => `${e.LogicalResourceId}: ${e.ResourceStatusReason}`)
    .join("; ");
}

export async function deployStack(o: AwsTarget & { stackName: string; trustedAccount?: string; log: Log; pollMs?: number; timeoutMs?: number }): Promise<StackState & { action: "created" | "updated" | "unchanged" }> {
  const { CloudFormationClient, CreateStackCommand, UpdateStackCommand } = await import("@aws-sdk/client-cloudformation");
  const account = await callerAccount(o);
  const cfn = new CloudFormationClient(auth(o));
  const wait = { pollMs: o.pollMs ?? AWS_STACK.pollMs, timeoutMs: o.timeoutMs ?? AWS_STACK.timeoutMs, log: o.log };
  try {
    const existing = await describe(cfn, o.stackName);
    const status = existing?.StackStatus;
    if (status?.endsWith("_IN_PROGRESS")) throw new Error(`Stack ${o.stackName} is busy (${status}); try again when it finishes`);
    if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") {
      throw new Error(`Stack ${o.stackName} failed to create (${status}). Remove it with: sikrets aws disconnect --yes, then connect again`);
    }
    const previousTrust = existing?.Parameters?.find((p) => p.ParameterKey === AWS_STACK.params.trustedAccount)?.ParameterValue;
    const trustedAccount = o.trustedAccount ?? previousTrust ?? account;
    const ext = await externalId(o.region, o.stackName);
    if (existing && ext.minted) o.log("No external ID for this stack in your keychain; setting a new one.");
    const input = {
      StackName: o.stackName,
      TemplateBody: TEMPLATE,
      Capabilities: [...AWS_STACK.capabilities],
      Parameters: Object.entries(stackParameters({ trustedAccount, externalId: ext.value })).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      Tags: [{ Key: AWS_STACK.managedByTag, Value: MANAGED_BY_TAG }],
    };

    let action: "created" | "updated" | "unchanged";
    if (!existing) {
      o.log(`Creating stack ${o.stackName} in ${account} (${o.region})…`);
      await cfn.send(new CreateStackCommand({ ...input, OnFailure: "ROLLBACK" }));
      action = "created";
    } else {
      o.log(`Updating stack ${o.stackName} in ${account} (${o.region})…`);
      try {
        await cfn.send(new UpdateStackCommand(input));
        action = "updated";
      } catch (e) {
        if (!isNoop(e)) throw e;
        action = "unchanged";
      }
    }

    const done = action === "unchanged" ? existing : await settle(cfn, existing?.StackId ?? o.stackName, wait);
    const final = done?.StackStatus;
    if (final !== "CREATE_COMPLETE" && final !== "UPDATE_COMPLETE") {
      const why = await failureReasons(cfn, done?.StackId ?? o.stackName).catch(() => "");
      throw new Error(`Stack ${o.stackName} ended in ${final ?? "an unknown state"}${why ? `: ${why}` : ""}`);
    }

    const out = Object.fromEntries((done!.Outputs ?? []).map((x) => [x.OutputKey, x.OutputValue]));
    const need = (k: string) => {
      const v = out[k];
      if (!v) throw new Error(`Stack ${o.stackName} has no ${k} output; is it the Sikrets template?`);
      return v;
    };
    const state: StackState = {
      stackName: o.stackName,
      stackId: done!.StackId!,
      region: o.region,
      account,
      trustedAccount,
      ...(o.profile ? { profile: o.profile } : {}),
      brokerRoleArn: need(AWS_STACK.outputs.brokerRole),
      keyArn: need(AWS_STACK.outputs.key),
      boundaryArn: need(AWS_STACK.outputs.boundary),
      agentRolePath: need(AWS_STACK.outputs.agentRolePath),
      auditLogGroup: need(AWS_STACK.outputs.auditLogGroup),
      connectedAt: new Date().toISOString(),
    };
    await saveStack(state);
    return { ...state, action };
  } finally {
    cfn.destroy();
  }
}

/** Deletes every agent role (they carry the boundary, which blocks deleting it), then the stack. */
export async function deleteStack(s: StackState, o: { profile?: string; log: Log; pollMs?: number; timeoutMs?: number }) {
  const { CloudFormationClient, DeleteStackCommand } = await import("@aws-sdk/client-cloudformation");
  const t = { region: s.region, ...(o.profile ?? s.profile ? { profile: (o.profile ?? s.profile)! } : {}) };
  const broker = await brokerSession(s, t.profile);
  const iam = await iamClient(broker, s.region);
  let roles: string[];
  try {
    roles = await listAgentRoles(iam, s.agentRolePath);
    for (const name of roles) {
      await deleteAgentRole(iam, name);
      o.log(`  deleted agent role ${name}`);
    }
  } finally {
    iam.destroy();
  }
  const cfn = new CloudFormationClient(auth(t));
  try {
    o.log(`Deleting stack ${s.stackName}…`);
    await cfn.send(new DeleteStackCommand({ StackName: s.stackId }));
    const done = await settle(cfn, s.stackId, { pollMs: o.pollMs ?? AWS_STACK.pollMs, timeoutMs: o.timeoutMs ?? AWS_STACK.timeoutMs, log: o.log });
    if (done && done.StackStatus !== "DELETE_COMPLETE") {
      const why = await failureReasons(cfn, s.stackId).catch(() => "");
      throw new Error(`Stack ${s.stackName} ended in ${done.StackStatus}${why ? `: ${why}` : ""}`);
    }
  } finally {
    cfn.destroy();
  }
  await remove(stateFile());
  await keychain.delete("aws", externalIdKey(s.region, s.stackName));
  return { agentRoles: roles };
}

// ── Broker and agent roles ────────────────────────────────────────────────

/** Short-lived credentials as the broker role, from your local AWS credentials and the external ID. */
export async function brokerSession(s: StackState, profile?: string): Promise<AwsCredentials> {
  const ext = await keychain.get("aws", externalIdKey(s.region, s.stackName));
  if (!ext) throw new Error(`No external ID for stack ${s.stackName} in your keychain. Run sikrets aws connect to set a new one`);
  return stsCredentials({
    region: s.region,
    ...(profile ? { profile } : {}),
    role: s.brokerRoleArn,
    externalId: ext,
    seconds: AWS_STACK.brokerSeconds,
    sessionName: AWS_STACK.brokerSessionName,
  });
}

type Iam = InstanceType<typeof import("@aws-sdk/client-iam").IAMClient>;

export async function iamClient(credentials: AwsCredentials, region: string): Promise<Iam> {
  const { IAMClient } = await import("@aws-sdk/client-iam");
  return new IAMClient({ region, credentials });
}

export const agentRoleName = (agent: string) => `${AGENT_ROLE.namePrefix}${agent}`;

export interface Statement {
  Effect: "Allow";
  Action: string[];
  Resource: string;
}

/**
 * Parses --allow values: `ACTION[,ACTION…][=RESOURCE]`, e.g. `s3:GetObject,s3:ListBucket=arn:aws:s3:::logs/*`.
 * Without a resource it's "*" (the boundary still applies). One statement per resource.
 */
export function parseAllow(values: readonly string[]): Statement[] {
  const byResource = new Map<string, Set<string>>();
  for (const raw of values) {
    const i = raw.indexOf("=");
    const actions = (i < 0 ? raw : raw.slice(0, i)).split(",").map((a) => a.trim()).filter(Boolean);
    const resource = i < 0 ? "*" : raw.slice(i + 1).trim();
    if (!actions.length) throw new Error(`--allow ${raw}: name at least one action, e.g. s3:GetObject`);
    if (resource !== "*" && !resource.startsWith("arn:")) throw new Error(`--allow ${raw}: the resource must be an ARN or *`);
    for (const a of actions) {
      if (!/^[a-z0-9-]+:[A-Za-z0-9*]+$/.test(a)) throw new Error(`--allow ${raw}: "${a}" isn't an IAM action like s3:GetObject`);
      const service = a.split(":")[0]!;
      if ((AGENT_ROLE.deniedServices as readonly string[]).includes(service)) {
        throw new Error(`--allow ${raw}: agent roles can never use ${service}:* (the stack's permissions boundary denies it)`);
      }
    }
    const set = byResource.get(resource) ?? new Set<string>();
    for (const a of actions) set.add(a);
    byResource.set(resource, set);
  }
  return [...byResource].map(([Resource, actions]) => ({ Effect: "Allow" as const, Action: [...actions].sort(), Resource }));
}

/** Creates the agent's role under the boundary if needed, and sets its permissions when given. */
export async function ensureAgentRole(iam: Iam, s: StackState, agent: string, statements: Statement[] | undefined) {
  const { GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand } = await import("@aws-sdk/client-iam");
  const RoleName = agentRoleName(agent);
  let role = await iam.send(new GetRoleCommand({ RoleName })).then(
    (r) => r.Role,
    (e) => {
      if (errorName(e) === "NoSuchEntityException" || errorName(e) === "NoSuchEntity") return undefined;
      throw e;
    },
  );
  let created = false;
  if (role) {
    const tagged = role.Tags?.some((t) => t.Key === AGENT_ROLE.tag && t.Value === agent);
    if (!tagged || role.PermissionsBoundary?.PermissionsBoundaryArn !== s.boundaryArn) {
      throw new Error(`Role ${RoleName} exists but isn't a Sikrets agent role (missing the ${AGENT_ROLE.tag} tag or the boundary); refusing to touch it`);
    }
  } else {
    if (!statements?.length) throw new Error(`Agent ${agent} has no role yet. Say what it may do: --allow s3:GetObject=arn:aws:s3:::bucket/*`);
    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: s.brokerRoleArn }, Action: "sts:AssumeRole" }] };
    role = (
      await iam.send(
        new CreateRoleCommand({
          RoleName,
          Path: s.agentRolePath,
          Description: `Sikrets agent ${agent}`,
          AssumeRolePolicyDocument: JSON.stringify(trust),
          PermissionsBoundary: s.boundaryArn,
          MaxSessionDuration: AGENT_ROLE.maxSessionSeconds,
          Tags: [
            { Key: AGENT_ROLE.tag, Value: agent },
            { Key: AWS_STACK.managedByTag, Value: MANAGED_BY_TAG },
          ],
        }),
      )
    ).Role;
    created = true;
  }
  if (statements?.length) {
    const policy = { Version: "2012-10-17", Statement: statements };
    await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: AGENT_ROLE.policyName, PolicyDocument: JSON.stringify(policy) }));
  }
  if (!role?.Arn) throw new Error(`IAM returned no ARN for ${RoleName}`);
  return { arn: role.Arn, name: RoleName, created };
}

/** Temporary credentials for the agent role, assumed as the broker. A new role can take a few seconds to work. */
export async function agentCredentials(broker: AwsCredentials, o: { region: string; roleArn: string; agent: string; seconds: number; fresh: boolean }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await stsCredentials({ credentials: broker, region: o.region, role: o.roleArn, seconds: o.seconds, sessionName: AGENT_ROLE.sessionName(o.agent) });
    } catch (e) {
      if (!o.fresh || errorName(e) !== "AccessDenied" || attempt >= AGENT_ROLE.assumeRetries) throw e;
      await Bun.sleep(AGENT_ROLE.assumeRetryMs);
    }
  }
}

export async function listAgentRoles(iam: Iam, rolePath: string): Promise<string[]> {
  const { ListRolesCommand } = await import("@aws-sdk/client-iam");
  const names: string[] = [];
  let Marker: string | undefined;
  do {
    const page = await iam.send(new ListRolesCommand({ PathPrefix: rolePath, ...(Marker ? { Marker } : {}) }));
    for (const r of page.Roles ?? []) if (r.RoleName) names.push(r.RoleName);
    Marker = page.IsTruncated ? page.Marker : undefined;
  } while (Marker);
  return names;
}

export async function deleteAgentRole(iam: Iam, RoleName: string) {
  const { ListRolePoliciesCommand, DeleteRolePolicyCommand, DeleteRoleCommand } = await import("@aws-sdk/client-iam");
  const { PolicyNames = [] } = await iam.send(new ListRolePoliciesCommand({ RoleName }));
  for (const PolicyName of PolicyNames) await iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName }));
  await iam.send(new DeleteRoleCommand({ RoleName }));
}
