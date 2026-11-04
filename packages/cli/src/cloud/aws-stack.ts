import path from "node:path";
import template from "../../../stack/sikrets.yaml" with { type: "text" };
import { configDir, keychain } from "../store.ts";
import { readJson, remove, writePrivate } from "../core/fs.ts";
import { stsCredentials } from "../core/aws-session.ts";
import { AGENT_ROLE, AWS_STACK, MANAGED_BY_TAG, SSM_PREFIX } from "../constants.ts";

// The Sikrets stack in your own AWS account (packages/stack/sikrets.yaml): the vault (SSM Parameter
// Store under the stack's KMS key), a permissions boundary every agent role carries, an event bus
// and audit log for secret access, and optional GitHub Actions and cross-account broker roles.
// Everything here runs on your own AWS credentials; the broker is only for a Sikrets service in
// another account, and is off unless you pass --trust-account.

export const TEMPLATE: string = template;

/** What `connect` records about the stack. No secrets: the broker's external ID lives in the keychain. */
export interface StackState {
  stackName: string;
  stackId: string;
  region: string;
  account: string;
  profile?: string;
  keyArn: string;
  vaultPath: string;
  boundaryArn: string;
  managerPolicyArn: string;
  agentRolePath: string;
  eventBusName: string;
  eventBusArn: string;
  auditLogGroup: string;
  brokerRoleArn?: string;
  trustedAccount?: string;
  githubRoleArn?: string;
  githubRepository?: string;
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
  if (!s) throw new Error("No Sikrets stack connected. Deploy one to your AWS account: sikrets cloud connect --provider aws");
  return s;
}

const auth = (t: AwsTarget) => ({ region: t.region, ...(t.profile ? { profile: t.profile } : {}) });
/** SDK client config for calls into the stack's account with your own credentials. */
export const stackClientConfig = (s: StackState, profile?: string) => auth({ region: s.region, ...((profile ?? s.profile) ? { profile: (profile ?? s.profile)! } : {}) });
const errorName = (e: unknown) => (e as { name?: string })?.name ?? "";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── External ID (optional broker only) ─────────────────────────────────────

const externalIdKey = (region: string, stackName: string) => AWS_STACK.externalIdAccount(region, stackName);

/** The broker's external ID from the keychain, minted (and saved) on first use. */
export async function externalId(region: string, stackName: string): Promise<{ value: string; minted: boolean }> {
  const stored = await keychain.get("aws", externalIdKey(region, stackName));
  if (stored) return { value: stored, minted: false };
  const value = Buffer.from(crypto.getRandomValues(new Uint8Array(AWS_STACK.externalIdBytes))).toString("base64url");
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

export interface StackOptions {
  /** owner/repo whose GitHub Actions may assume the github-actions agent role. */
  githubRepository: string;
  /** The account already has GitHub's OIDC provider; don't create another. */
  githubProviderExists: boolean;
  /** Account of a cross-account Sikrets broker; empty for none (the default). */
  trustedAccount: string;
  externalId: string;
}

export function stackParameters(o: StackOptions): Record<string, string> {
  return {
    [AWS_STACK.params.vaultPath]: `${SSM_PREFIX}/`,
    [AWS_STACK.params.agentRolePath]: AGENT_ROLE.path,
    [AWS_STACK.params.githubRepository]: o.githubRepository,
    [AWS_STACK.params.createGitHubProvider]: o.githubProviderExists ? "false" : "true",
    [AWS_STACK.params.trustedAccount]: o.trustedAccount,
    [AWS_STACK.params.externalId]: o.trustedAccount ? o.externalId : "",
  };
}

/** A CloudFormation console link that creates the stack with its parameters filled in. */
export function quickCreateUrl(o: StackOptions & { region: string; stackName: string; templateUrl: string }) {
  const q = new URLSearchParams({ templateURL: o.templateUrl, stackName: o.stackName });
  for (const [k, v] of Object.entries(stackParameters(o))) if (v) q.set(`param_${k}`, v);
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

/** Polls until the stack leaves *_IN_PROGRESS; returns it (undefined once it's gone). */
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

export async function deployStack(
  o: AwsTarget & { stackName: string; githubRepository?: string; githubProviderExists?: boolean; trustedAccount?: string; log: Log; pollMs?: number; timeoutMs?: number },
): Promise<StackState & { action: "created" | "updated" | "unchanged" }> {
  const { CloudFormationClient, CreateStackCommand, UpdateStackCommand } = await import("@aws-sdk/client-cloudformation");
  const account = await callerAccount(o);
  const cfn = new CloudFormationClient(auth(o));
  const wait = { pollMs: o.pollMs ?? AWS_STACK.pollMs, timeoutMs: o.timeoutMs ?? AWS_STACK.timeoutMs, log: o.log };
  try {
    const existing = await describe(cfn, o.stackName);
    const status = existing?.StackStatus;
    if (status?.endsWith("_IN_PROGRESS")) throw new Error(`Stack ${o.stackName} is busy (${status}); try again when it finishes`);
    if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") {
      throw new Error(`Stack ${o.stackName} failed to create (${status}). Remove it with: sikrets cloud disconnect --yes, then connect again`);
    }
    // Options not given this time keep the stack's current values.
    const prev = Object.fromEntries((existing?.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue ?? ""]));
    const trust = o.trustedAccount === AWS_STACK.noBroker ? "" : (o.trustedAccount ?? prev[AWS_STACK.params.trustedAccount] ?? "");
    const ext = trust ? await externalId(o.region, o.stackName) : undefined;
    if (existing && ext?.minted && prev[AWS_STACK.params.trustedAccount]) o.log("No broker external ID for this stack in your keychain; setting a new one.");
    const opts: StackOptions = {
      githubRepository: o.githubRepository ?? prev[AWS_STACK.params.githubRepository] ?? "",
      githubProviderExists: o.githubProviderExists ?? prev[AWS_STACK.params.createGitHubProvider] === "false",
      trustedAccount: trust,
      externalId: ext?.value ?? "",
    };
    const input = {
      StackName: o.stackName,
      TemplateBody: TEMPLATE,
      Capabilities: [...AWS_STACK.capabilities],
      Parameters: [
        ...Object.entries(stackParameters(opts)).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
        // Parameters the CLI doesn't manage (CreateTrail, AuditRetentionDays) keep what you set in the console.
        ...Object.keys(prev)
          .filter((k) => !(k in stackParameters(opts)))
          .map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })),
      ],
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
    if (!trust) await keychain.delete("aws", externalIdKey(o.region, o.stackName));

    const out: Record<string, string | undefined> = Object.fromEntries((done!.Outputs ?? []).map((x) => [x.OutputKey, x.OutputValue]));
    const need = (k: string) => {
      const v = out[k];
      if (!v) throw new Error(`Stack ${o.stackName} has no ${k} output; is it the Sikrets template?`);
      return v;
    };
    const broker = out[AWS_STACK.outputs.brokerRole];
    const github = out[AWS_STACK.outputs.githubRole];
    const state: StackState = {
      stackName: o.stackName,
      stackId: done!.StackId!,
      region: o.region,
      account,
      ...(o.profile ? { profile: o.profile } : {}),
      keyArn: need(AWS_STACK.outputs.key),
      vaultPath: need(AWS_STACK.outputs.vaultPath),
      boundaryArn: need(AWS_STACK.outputs.boundary),
      managerPolicyArn: need(AWS_STACK.outputs.managerPolicy),
      agentRolePath: need(AWS_STACK.outputs.agentRolePath),
      eventBusName: need(AWS_STACK.outputs.eventBus),
      eventBusArn: need(AWS_STACK.outputs.eventBusArn),
      auditLogGroup: need(AWS_STACK.outputs.auditLogGroup),
      ...(broker ? { brokerRoleArn: broker, trustedAccount: trust } : {}),
      ...(github ? { githubRoleArn: github, githubRepository: opts.githubRepository } : {}),
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
  const config = stackClientConfig(s, o.profile);
  const iam = await iamClient(config);
  const githubRole = s.githubRoleArn?.split("/").at(-1);
  let roles: string[];
  try {
    roles = await listAgentRoles(iam, s.agentRolePath);
    for (const name of roles) {
      // The stack owns the GitHub Actions role; only the permissions Sikrets added are removed here.
      await deleteAgentRole(iam, name, { keepRole: name === githubRole });
      o.log(`  removed agent role ${name}`);
    }
  } finally {
    iam.destroy();
  }
  const cfn = new CloudFormationClient(config);
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

// ── Agent roles ───────────────────────────────────────────────────────────

type Iam = InstanceType<typeof import("@aws-sdk/client-iam").IAMClient>;

export async function iamClient(config: { region: string; profile?: string }): Promise<Iam> {
  const { IAMClient } = await import("@aws-sdk/client-iam");
  return new IAMClient(config);
}

export const agentRoleName = (agent: string) => `${AGENT_ROLE.namePrefix}${agent}`;

export interface Statement {
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string>>;
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

/** ARN of one vault parameter, /sikrets/<project>/<KEY>, in the stack's account and region. */
export const parameterArn = (s: StackState, project: string, key: string) =>
  `arn:${s.keyArn.split(":")[1]}:ssm:${s.region}:${s.account}:parameter${s.vaultPath}${project}/${key}`;

/** Read access to exactly these vault secrets, and the key only through SSM. Until `expiresAt`, if given. */
export function vaultStatements(s: StackState, project: string, keys: readonly string[], expiresAt?: string): Statement[] {
  if (!keys.length) return [];
  const until: Record<string, Record<string, string>> = expiresAt ? { DateLessThan: { "aws:CurrentTime": expiresAt } } : {};
  return [
    { Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters"], Resource: [...keys].sort().map((k) => parameterArn(s, project, k)), ...(expiresAt ? { Condition: until } : {}) },
    { Effect: "Allow", Action: ["kms:Decrypt"], Resource: s.keyArn, Condition: { StringEquals: { "kms:ViaService": `ssm.${s.region}.amazonaws.com` }, ...until } },
  ];
}

const policyDoc = (statements: Statement[]) => JSON.stringify({ Version: "2012-10-17", Statement: statements });

/**
 * Creates the agent's role under the boundary if needed, and sets the policies given (vault: the
 * secrets in its scope; allow: extra actions). A policy left undefined is kept as it is.
 */
export async function ensureAgentRole(iam: Iam, s: StackState, agent: string, policies: { vault?: Statement[]; allow?: Statement[] }) {
  const { GetRoleCommand, CreateRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand } = await import("@aws-sdk/client-iam");
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
    if (!policies.vault?.length && !policies.allow?.length) {
      throw new Error(`Agent ${agent} has no role yet. Grant it secrets (sikrets agent add ${agent} --key <resource>) or actions (--allow s3:GetObject=arn:aws:s3:::bucket/*)`);
    }
    // You (anyone in this account IAM lets assume it) and, if enabled, the broker; nobody else.
    const principals = [`arn:${s.keyArn.split(":")[1]}:iam::${s.account}:root`, ...(s.brokerRoleArn ? [s.brokerRoleArn] : [])];
    const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principals }, Action: "sts:AssumeRole" }] };
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
  for (const [PolicyName, statements] of [
    [AGENT_ROLE.vaultPolicy, policies.vault],
    [AGENT_ROLE.allowPolicy, policies.allow],
  ] as const) {
    if (statements === undefined) continue;
    if (statements.length) await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName, PolicyDocument: policyDoc(statements) }));
    else if (!created) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName })).catch((e) => {
        if (!errorName(e).startsWith("NoSuchEntity")) throw e;
      });
    }
  }
  if (!role?.Arn) throw new Error(`IAM returned no ARN for ${RoleName}`);
  return { arn: role.Arn, name: RoleName, created };
}

/** Temporary credentials for the agent role, assumed with your credentials. A new role can take a few seconds to work. */
export async function agentCredentials(s: StackState, o: { roleArn?: string; agent: string; seconds: number; fresh?: boolean; profile?: string }) {
  const roleArn = o.roleArn ?? `arn:${s.keyArn.split(":")[1]}:iam::${s.account}:role${s.agentRolePath}${agentRoleName(o.agent)}`;
  const config = stackClientConfig(s, o.profile);
  for (let attempt = 0; ; attempt++) {
    try {
      return await stsCredentials({ ...config, role: roleArn, seconds: o.seconds, sessionName: AGENT_ROLE.sessionName(o.agent) });
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

/** Removes the role's inline policies, then the role (unless it's one the stack owns). Missing is fine. */
export async function deleteAgentRole(iam: Iam, RoleName: string, o: { keepRole?: boolean } = {}): Promise<boolean> {
  const { ListRolePoliciesCommand, DeleteRolePolicyCommand, DeleteRoleCommand } = await import("@aws-sdk/client-iam");
  try {
    const { PolicyNames = [] } = await iam.send(new ListRolePoliciesCommand({ RoleName }));
    for (const PolicyName of PolicyNames) await iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName }));
    if (!o.keepRole) await iam.send(new DeleteRoleCommand({ RoleName }));
    return true;
  } catch (e) {
    if (errorName(e).startsWith("NoSuchEntity")) return false;
    throw e;
  }
}
