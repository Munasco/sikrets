import { createHash } from "node:crypto";
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

/** Which stack, where. Recorded before any CloudFormation call, so a crash or timeout leaves it on disk. */
export interface StackTarget {
  stackName: string;
  region: string;
  account: string;
  profile?: string;
  stackId?: string;
}

/** The stack's outputs, as `connect` records them. No secrets: the broker's external ID lives in the keychain. */
export interface StackOutputs {
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
}

/**
 * Where the stack is, from CloudFormation's own status. Usable: ready, rolled-back (an update failed
 * and CloudFormation put the last good version back) and drifted (changed outside the template).
 * not-deployed: CloudFormation has no such stack; deleted-outside: it had one we recorded, and now
 * doesn't.
 */
export type StackStatus = "not-deployed" | "creating" | "updating" | "deleting" | "ready" | "rolled-back" | "drifted" | "failed" | "deleted-outside";
const USABLE = ["ready", "rolled-back", "drifted"] as const;
type Usable = (typeof USABLE)[number];
export const usable = (status: StackStatus): status is Usable => (USABLE as readonly StackStatus[]).includes(status);
export const inProgress = (status: StackStatus) => status === "creating" || status === "updating" || status === "deleting";

interface StackCheck {
  status: StackStatus;
  /** CloudFormation's own status, when it has the stack. */
  cfnStatus?: string;
  checkedAt: string;
}

/** A stack that's usable: every output is known. */
export type StackState = StackTarget & StackOutputs & StackCheck & { status: Usable; stackId: string; connectedAt: string };
/** What the state file holds: a usable stack, or one on its way somewhere (outputs kept from before, if any). */
export type StackRecord = StackState | (StackTarget & Partial<StackOutputs> & StackCheck & { status: Exclude<StackStatus, Usable>; connectedAt?: string });

/** Maps CloudFormation's status (undefined: no such stack) to ours. */
export function classify(cfnStatus: string | undefined, o: { drift?: string; recorded?: boolean } = {}): StackStatus {
  if (!cfnStatus || cfnStatus === "DELETE_COMPLETE") return o.recorded ? "deleted-outside" : "not-deployed";
  if (cfnStatus === "DELETE_IN_PROGRESS") return "deleting";
  if (cfnStatus === "CREATE_IN_PROGRESS" || cfnStatus === "ROLLBACK_IN_PROGRESS" || cfnStatus === "REVIEW_IN_PROGRESS") return "creating";
  if (cfnStatus.endsWith("_IN_PROGRESS")) return "updating";
  if (cfnStatus === "UPDATE_ROLLBACK_COMPLETE" || cfnStatus === "IMPORT_ROLLBACK_COMPLETE") return "rolled-back";
  if (cfnStatus === "CREATE_COMPLETE" || cfnStatus === "UPDATE_COMPLETE" || cfnStatus === "IMPORT_COMPLETE") return o.drift === "DRIFTED" ? "drifted" : "ready";
  return "failed"; // ROLLBACK_COMPLETE, ROLLBACK_FAILED, CREATE_FAILED, DELETE_FAILED, UPDATE_ROLLBACK_FAILED, …
}

/** What to do about a stack that isn't usable. */
export function stackProblem(r: StackRecord): string {
  const cfn = r.cfnStatus ? ` (${r.cfnStatus})` : "";
  switch (r.status) {
    case "creating":
    case "updating":
    case "deleting":
      return `Stack ${r.stackName} is ${r.status}${cfn}; try again when it finishes (sikrets cloud status)`;
    case "failed":
      return `Stack ${r.stackName} failed${cfn}. Remove it with: sikrets cloud disconnect --yes, then connect again`;
    case "deleted-outside":
      return `Stack ${r.stackName} was deleted outside Sikrets. Forget it with: sikrets cloud disconnect --yes, or deploy it again: sikrets cloud connect`;
    case "not-deployed":
      return `Stack ${r.stackName} isn't deployed. Deploy it: sikrets cloud connect --provider aws`;
    default:
      return `Stack ${r.stackName} is ${r.status}`;
  }
}

export interface AwsTarget {
  region: string;
  profile?: string;
}

type Log = (message: string) => void;

const stateFile = () => path.join(configDir(), AWS_STACK.stateFile);
/** The recorded stack. A file from before statuses were recorded held only usable stacks. */
export async function loadStack(): Promise<StackRecord | null> {
  const r = await readJson<(Omit<StackState, "status" | "checkedAt"> & Partial<StackCheck>) | null>(stateFile(), null);
  if (!r) return null;
  return r.status ? (r as StackRecord) : ({ ...r, status: "ready", checkedAt: r.connectedAt } as StackState);
}
const saveStack = (s: StackRecord) => writePrivate(stateFile(), JSON.stringify(s, null, 2) + "\n");

/** The connected stack, if it's usable. One that wasn't usable when last seen is checked again first. */
export async function connectedStack(): Promise<StackState> {
  const s = await loadStack();
  if (!s) throw new Error("No Sikrets stack connected. Deploy one to your AWS account: sikrets cloud connect --provider aws");
  if (usable(s.status)) return s as StackState;
  const now = await refreshStack(s);
  if (usable(now.status)) return now as StackState;
  throw new Error(stackProblem(now));
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
type CfnStack = NonNullable<Awaited<ReturnType<typeof describe>>>;

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
    // The stack keeps going without us; what's recorded says so, and the next command checks again.
    if (Date.now() > deadline) throw new Error(`Timed out waiting for stack ${stack} (still ${status}). Check on it with: sikrets cloud status`);
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

const now = () => new Date().toISOString();
const targetOf = (r: StackTarget): StackTarget => ({ stackName: r.stackName, region: r.region, account: r.account, ...(r.profile ? { profile: r.profile } : {}), ...(r.stackId ? { stackId: r.stackId } : {}) });
const sameStack = (r: StackTarget, t: StackTarget) => r.stackName === t.stackName && r.region === t.region && r.account === t.account;

/** The record for a stack CloudFormation reports as `cfn`: full outputs when usable, the last known ones otherwise. */
function recordFrom(t: StackTarget, cfn: CfnStack | undefined, prev?: StackRecord | null): StackRecord {
  const status = classify(cfn?.StackStatus, { drift: cfn?.DriftInformation?.StackDriftStatus, recorded: Boolean(prev) });
  const check = { ...(cfn?.StackStatus ? { cfnStatus: cfn.StackStatus } : {}), checkedAt: now() };
  const target = { ...targetOf(t), ...(cfn?.StackId ? { stackId: cfn.StackId } : {}) };
  if (!usable(status) || !cfn) {
    const { status: _, cfnStatus: __, checkedAt: ___, ...kept } = prev && sameStack(prev, t) ? prev : ({} as Partial<StackRecord>);
    return { ...kept, ...target, ...check, status: status as Exclude<StackStatus, Usable> } as StackRecord;
  }
  const out: Record<string, string | undefined> = Object.fromEntries((cfn.Outputs ?? []).map((x) => [x.OutputKey, x.OutputValue]));
  const params: Record<string, string> = Object.fromEntries((cfn.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue ?? ""]));
  const need = (k: string) => {
    const v = out[k];
    if (!v) throw new Error(`Stack ${t.stackName} has no ${k} output; is it the Sikrets template?`);
    return v;
  };
  const broker = out[AWS_STACK.outputs.brokerRole];
  const github = out[AWS_STACK.outputs.githubRole];
  return {
    ...target,
    stackId: cfn.StackId!,
    keyArn: need(AWS_STACK.outputs.key),
    vaultPath: need(AWS_STACK.outputs.vaultPath),
    boundaryArn: need(AWS_STACK.outputs.boundary),
    managerPolicyArn: need(AWS_STACK.outputs.managerPolicy),
    agentRolePath: need(AWS_STACK.outputs.agentRolePath),
    eventBusName: need(AWS_STACK.outputs.eventBus),
    eventBusArn: need(AWS_STACK.outputs.eventBusArn),
    auditLogGroup: need(AWS_STACK.outputs.auditLogGroup),
    ...(broker ? { brokerRoleArn: broker, trustedAccount: params[AWS_STACK.params.trustedAccount] ?? "" } : {}),
    ...(github ? { githubRoleArn: github, githubRepository: params[AWS_STACK.params.githubRepository] ?? "" } : {}),
    ...check,
    status,
    connectedAt: (prev && sameStack(prev, t) && prev.connectedAt) || now(),
  };
}

/** Asks CloudFormation where the recorded stack is now, and records the answer. */
export async function refreshStack(r: StackRecord, o: { profile?: string } = {}): Promise<StackRecord> {
  const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
  const cfn = new CloudFormationClient(auth({ region: r.region, ...((o.profile ?? r.profile) ? { profile: (o.profile ?? r.profile)! } : {}) }));
  try {
    const next = recordFrom(r, await describe(cfn, r.stackId ?? r.stackName), r);
    await saveStack(next);
    return next;
  } finally {
    cfn.destroy();
  }
}

export async function deployStack(
  o: AwsTarget & { stackName: string; githubRepository?: string; githubProviderExists?: boolean; trustedAccount?: string; log: Log; pollMs?: number; timeoutMs?: number },
): Promise<StackState & { action: "created" | "updated" | "unchanged" }> {
  const { CloudFormationClient, CreateStackCommand, UpdateStackCommand } = await import("@aws-sdk/client-cloudformation");
  const account = await callerAccount(o);
  const target: StackTarget = { stackName: o.stackName, region: o.region, account, ...(o.profile ? { profile: o.profile } : {}) };
  // One stack at a time: connecting another would leave the first, with its vault and roles, unmanaged.
  let recorded = await loadStack();
  if (recorded && !sameStack(recorded, target)) {
    recorded = await refreshStack(recorded).catch(() => recorded!);
    if (recorded.status !== "deleted-outside" && recorded.status !== "not-deployed") {
      throw new Error(
        `Already connected to stack ${recorded.stackName} in ${recorded.account} (${recorded.region}, ${recorded.status}). Disconnect it first (sikrets cloud disconnect --yes), or update it with: sikrets cloud connect --stack ${recorded.stackName} --region ${recorded.region}`,
      );
    }
    recorded = null; // gone: nothing left to orphan
  }
  const cfn = new CloudFormationClient(auth(o));
  const wait = { pollMs: o.pollMs ?? AWS_STACK.pollMs, timeoutMs: o.timeoutMs ?? AWS_STACK.timeoutMs, log: o.log };
  try {
    const existing = await describe(cfn, o.stackName);
    const seen = recordFrom(target, existing, recorded);
    if (inProgress(seen.status) || seen.status === "failed") {
      await saveStack(seen); // so disconnect (and status) can act on it
      throw new Error(stackProblem(seen));
    }
    const live = existing && seen.status !== "not-deployed" && seen.status !== "deleted-outside" ? existing : undefined;
    // Options not given this time keep the stack's current values.
    const prev = Object.fromEntries((live?.Parameters ?? []).map((p) => [p.ParameterKey, p.ParameterValue ?? ""]));
    const trust = o.trustedAccount === AWS_STACK.noBroker ? "" : (o.trustedAccount ?? prev[AWS_STACK.params.trustedAccount] ?? "");
    const ext = trust ? await externalId(o.region, o.stackName) : undefined;
    if (live && ext?.minted && prev[AWS_STACK.params.trustedAccount]) o.log("No broker external ID for this stack in your keychain; setting a new one.");
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

    // Intent first: if this process dies mid-deploy, the record says what was under way.
    let action: "created" | "updated" | "unchanged";
    let stack = live?.StackId ?? o.stackName;
    if (!live) {
      o.log(`Creating stack ${o.stackName} in ${account} (${o.region})…`);
      await saveStack({ ...target, status: "creating", checkedAt: now() });
      const { StackId } = await cfn.send(new CreateStackCommand({ ...input, OnFailure: "ROLLBACK" }));
      if (StackId) {
        stack = StackId;
        await saveStack({ ...target, stackId: StackId, status: "creating", checkedAt: now() });
      }
      action = "created";
    } else {
      o.log(`Updating stack ${o.stackName} in ${account} (${o.region})…`);
      await saveStack({ ...seen, status: "updating", checkedAt: now() } as StackRecord);
      try {
        await cfn.send(new UpdateStackCommand(input));
        action = "updated";
      } catch (e) {
        if (!isNoop(e)) {
          await saveStack(seen); // refused outright: nothing changed
          throw e;
        }
        action = "unchanged";
      }
    }

    const done = action === "unchanged" ? live : await settle(cfn, stack, wait);
    const final = recordFrom({ ...target, ...(done?.StackId ? { stackId: done.StackId } : {}) }, done, (await loadStack()) ?? undefined);
    await saveStack(final);
    // Nothing to change leaves a usable stack as it is (a rolled-back one included); a change must land.
    if (action === "unchanged" ? !usable(final.status) : final.status !== "ready" && final.status !== "drifted") {
      const why = await failureReasons(cfn, done?.StackId ?? o.stackName).catch(() => "");
      throw new Error(`Stack ${o.stackName} ended in ${final.cfnStatus ?? "an unknown state"}${why ? `: ${why}` : ""}${final.status === "failed" ? ". Remove it with: sikrets cloud disconnect --yes, then connect again" : ""}`);
    }
    if (!trust) await keychain.delete("aws", externalIdKey(o.region, o.stackName));
    return { ...(final as StackState), action };
  } finally {
    cfn.destroy();
  }
}

/** A Sikrets stack to remove that isn't recorded here: found by name, and refused unless it carries our tag. */
export async function findStack(t: AwsTarget & { stackName: string }): Promise<StackRecord> {
  const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
  const account = await callerAccount(t);
  const cfn = new CloudFormationClient(auth(t));
  try {
    const found = await describe(cfn, t.stackName);
    if (found && !found.Tags?.some((x) => x.Key === AWS_STACK.managedByTag && x.Value === MANAGED_BY_TAG)) {
      throw new Error(`Stack ${t.stackName} isn't a Sikrets stack (no ${AWS_STACK.managedByTag} tag); refusing to touch it`);
    }
    return recordFrom({ stackName: t.stackName, region: t.region, account, ...(t.profile ? { profile: t.profile } : {}) }, found);
  } finally {
    cfn.destroy();
  }
}

/**
 * Deletes every agent role (they carry the boundary, which blocks deleting it), then the stack, in
 * any state but mid-change: a failed create (ROLLBACK_COMPLETE) included. A stack that's already
 * gone is just forgotten. Records "deleting" first, so an interrupted run is picked up again.
 */
export async function deleteStack(r: StackRecord, o: { profile?: string; log: Log; pollMs?: number; timeoutMs?: number }): Promise<{ agentRoles: string[]; forgotten: boolean }> {
  const { CloudFormationClient, DeleteStackCommand } = await import("@aws-sdk/client-cloudformation");
  const config = auth({ region: r.region, ...((o.profile ?? r.profile) ? { profile: (o.profile ?? r.profile)! } : {}) });
  const wait = { pollMs: o.pollMs ?? AWS_STACK.pollMs, timeoutMs: o.timeoutMs ?? AWS_STACK.timeoutMs, log: o.log };
  const cfn = new CloudFormationClient(config);
  try {
    const seen = recordFrom(r, await describe(cfn, r.stackId ?? r.stackName), r);
    if (seen.status === "not-deployed" || seen.status === "deleted-outside") {
      await forget(r);
      return { agentRoles: [], forgotten: true };
    }
    if (seen.status === "creating" || seen.status === "updating") {
      await saveStack(seen);
      throw new Error(stackProblem(seen));
    }
    await saveStack({ ...seen, status: "deleting", checkedAt: now() } as StackRecord);
    const iam = await iamClient(config);
    let roles: string[];
    try {
      roles = await listAgentRoles(iam, r.agentRolePath ?? AGENT_ROLE.path);
      for (const name of roles) {
        // The stack owns the GitHub Actions role; only the permissions Sikrets added are removed here.
        await deleteAgentRole(iam, name, { keepRole: name === GITHUB_ROLE });
        o.log(`  removed agent role ${name}`);
      }
    } finally {
      iam.destroy();
    }
    const stack = seen.stackId ?? r.stackName;
    o.log(`Deleting stack ${r.stackName}…`);
    await cfn.send(new DeleteStackCommand({ StackName: stack }));
    const done = await settle(cfn, stack, wait);
    if (done && done.StackStatus !== "DELETE_COMPLETE") {
      await saveStack(recordFrom(r, done, r));
      const why = await failureReasons(cfn, stack).catch(() => "");
      throw new Error(`Stack ${r.stackName} ended in ${done.StackStatus}${why ? `: ${why}` : ""}`);
    }
    await forget(r);
    return { agentRoles: roles, forgotten: false };
  } finally {
    cfn.destroy();
  }
}

/** Drops the record (only if it's this stack's) and the broker's external ID. */
async function forget(r: StackTarget) {
  const recorded = await loadStack();
  if (recorded && sameStack(recorded, r)) await remove(stateFile());
  await keychain.delete("aws", externalIdKey(r.region, r.stackName));
}

// ── Agent roles ───────────────────────────────────────────────────────────

type Iam = InstanceType<typeof import("@aws-sdk/client-iam").IAMClient>;

export async function iamClient(config: { region: string; profile?: string }): Promise<Iam> {
  const { IAMClient } = await import("@aws-sdk/client-iam");
  return new IAMClient(config);
}

// Agents are per project, so roles are too: agent `claude` in two projects gets two roles. The name
// carries a hash of the project (IAM role names are account-wide, and at most 64 characters), the
// sikrets:project tag carries the project itself, and inline policies are suffixed the same way, so
// the GitHub Actions role (one per stack) holds each project's grants side by side.

const GITHUB_ROLE = `${AGENT_ROLE.namePrefix}${AGENT_ROLE.githubAgent}`;
const isGithub = (agent: string) => agent === AGENT_ROLE.githubAgent;
export const projectHash = (project: string) => createHash("sha256").update(project).digest("hex").slice(0, AGENT_ROLE.projectHashLength);
export const agentRoleName = (project: string, agent: string) => (isGithub(agent) ? GITHUB_ROLE : `${AGENT_ROLE.namePrefix}${agent}-${projectHash(project)}`);
/** Before roles were per project: one role per agent name for the whole stack. */
const legacyRoleName = (agent: string) => `${AGENT_ROLE.namePrefix}${agent}`;
export const policyNames = (project: string) => ({ vault: `${AGENT_ROLE.vaultPolicy}-${projectHash(project)}`, allow: `${AGENT_ROLE.allowPolicy}-${projectHash(project)}` });
const LEGACY_POLICIES = { vault: AGENT_ROLE.vaultPolicy, allow: AGENT_ROLE.allowPolicy };

export interface Statement {
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string>>;
}

const untilCondition = (expiresAt?: string) => (expiresAt ? { DateLessThan: { "aws:CurrentTime": expiresAt } } : undefined);

/**
 * Parses --allow values: `ACTION[,ACTION…][=RESOURCE]`, e.g. `s3:GetObject,s3:ListBucket=arn:aws:s3:::logs/*`.
 * Without a resource it's "*" (the boundary still applies). One statement per resource, each
 * usable only until `expiresAt` when the agent expires.
 */
export function parseAllow(values: readonly string[], expiresAt?: string): Statement[] {
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
  const until = untilCondition(expiresAt);
  return [...byResource].map(([Resource, actions]) => ({ Effect: "Allow" as const, Action: [...actions].sort(), Resource, ...(until ? { Condition: until } : {}) }));
}

/** ARN of one vault parameter, /sikrets/<project>/<KEY>, in the stack's account and region. */
export const parameterArn = (s: StackState, project: string, key: string) =>
  `arn:${s.keyArn.split(":")[1]}:ssm:${s.region}:${s.account}:parameter${s.vaultPath}${project}/${key}`;

/** Read access to exactly these vault secrets, and the key only through SSM. Until `expiresAt`, if given. */
export function vaultStatements(s: StackState, project: string, keys: readonly string[], expiresAt?: string): Statement[] {
  if (!keys.length) return [];
  const until = untilCondition(expiresAt);
  return [
    { Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters"], Resource: [...keys].sort().map((k) => parameterArn(s, project, k)), ...(until ? { Condition: until } : {}) },
    { Effect: "Allow", Action: ["kms:Decrypt"], Resource: s.keyArn, Condition: { StringEquals: { "kms:ViaService": `ssm.${s.region}.amazonaws.com` }, ...(until ?? {}) } },
  ];
}

const policyDoc = (statements: Statement[]) => JSON.stringify({ Version: "2012-10-17", Statement: statements });
const missingEntity = (e: unknown) => errorName(e).startsWith("NoSuchEntity");

type IamRole = NonNullable<Awaited<ReturnType<typeof getRole>>>;
async function getRole(iam: Iam, RoleName: string) {
  const { GetRoleCommand } = await import("@aws-sdk/client-iam");
  return iam.send(new GetRoleCommand({ RoleName })).then(
    (r) => r.Role,
    (e) => {
      if (missingEntity(e)) return undefined;
      throw e;
    },
  );
}
const tagOf = (role: IamRole, key: string) => role.Tags?.find((t) => t.Key === key)?.Value;

async function getPolicy(iam: Iam, RoleName: string, PolicyName: string): Promise<string | undefined> {
  const { GetRolePolicyCommand } = await import("@aws-sdk/client-iam");
  try {
    const doc = (await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName }))).PolicyDocument;
    return doc ? decodeURIComponent(doc) : undefined; // IAM returns policy documents URL-encoded
  } catch (e) {
    if (missingEntity(e)) return undefined;
    throw e;
  }
}

/**
 * A pre-project role's policies, if they belong to `project`: its vault policy reads only this
 * project's secrets (or it has none, as for a role made only with --allow). Undefined when there's
 * nothing to take over, or it's another project's (that project migrates it when it next runs).
 */
async function legacyPolicies(iam: Iam, s: StackState, RoleName: string, project: string, agent: string): Promise<{ vault?: string; allow?: string } | undefined> {
  const role = await getRole(iam, RoleName);
  if (!role || tagOf(role, AGENT_ROLE.tag) !== agent || tagOf(role, AGENT_ROLE.projectTag) !== undefined) return undefined;
  const [vault, allow] = [await getPolicy(iam, RoleName, LEGACY_POLICIES.vault), await getPolicy(iam, RoleName, LEGACY_POLICIES.allow)];
  if (vault) {
    const mine = `parameter${s.vaultPath}${project}/`;
    const resources = (JSON.parse(vault).Statement as Statement[]).filter((x) => x.Action.some((a) => a.startsWith("ssm:"))).flatMap((x) => [x.Resource].flat());
    if (!resources.every((r) => r.includes(mine))) return undefined;
  }
  if (!vault && !allow && !isGithub(agent)) return {}; // an empty role: nothing to carry over, just remove it
  if (!vault && !allow) return undefined;
  return { ...(vault ? { vault } : {}), ...(allow ? { allow } : {}) };
}

export interface RoleGrant {
  project: string;
  agent: string;
  /** Kept in the role's expiry tag; undefined means no expiry. */
  expiresAt?: string;
}

/**
 * Creates the agent's role for this project under the boundary if needed, and sets the policies
 * given (vault: the secrets in its scope; allow: extra actions). A policy left undefined is kept as
 * it is. A role from before roles were per project is taken over (its policies copied) and removed.
 */
export async function ensureAgentRole(iam: Iam, s: StackState, g: RoleGrant, policies: { vault?: Statement[]; allow?: Statement[] }) {
  const { CreateRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand, TagRoleCommand } = await import("@aws-sdk/client-iam");
  const { project, agent } = g;
  const RoleName = agentRoleName(project, agent);
  const names = policyNames(project);
  const expiresTag = g.expiresAt ?? AGENT_ROLE.noExpiry;
  let role = await getRole(iam, RoleName);
  const legacyName = isGithub(agent) ? RoleName : legacyRoleName(agent);
  const legacy = await legacyPolicies(iam, s, legacyName, project, agent).catch(() => undefined);
  let created = false;
  if (role) {
    const tagged = tagOf(role, AGENT_ROLE.tag) === agent;
    if (!tagged || role.PermissionsBoundary?.PermissionsBoundaryArn !== s.boundaryArn) {
      throw new Error(`Role ${RoleName} exists but isn't a Sikrets agent role (missing the ${AGENT_ROLE.tag} tag or the boundary); refusing to touch it`);
    }
    const owner = tagOf(role, AGENT_ROLE.projectTag);
    if (!isGithub(agent) && owner !== undefined && owner !== project) throw new Error(`Role ${RoleName} belongs to project ${owner}, not ${project}; refusing to touch it`);
    if (!isGithub(agent) && tagOf(role, AGENT_ROLE.expiresTag) !== expiresTag) {
      await iam.send(new TagRoleCommand({ RoleName, Tags: [{ Key: AGENT_ROLE.expiresTag, Value: expiresTag }] }));
    }
  } else {
    if (!policies.vault?.length && !policies.allow?.length && !legacy?.vault && !legacy?.allow) {
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
          Description: `Sikrets agent ${agent} (project ${project})`,
          AssumeRolePolicyDocument: JSON.stringify(trust),
          PermissionsBoundary: s.boundaryArn,
          MaxSessionDuration: AGENT_ROLE.maxSessionSeconds,
          Tags: [
            { Key: AGENT_ROLE.tag, Value: agent },
            { Key: AGENT_ROLE.projectTag, Value: project },
            { Key: AGENT_ROLE.expiresTag, Value: expiresTag },
            { Key: AWS_STACK.managedByTag, Value: MANAGED_BY_TAG },
          ],
        }),
      )
    ).Role;
    created = true;
  }
  for (const [kind, statements] of [
    ["vault", policies.vault],
    ["allow", policies.allow],
  ] as const) {
    const PolicyName = names[kind];
    if (statements === undefined) {
      // Not given: a role being taken over keeps what the old one had.
      const carried = legacy?.[kind];
      if (carried) await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName, PolicyDocument: carried }));
      continue;
    }
    if (statements.length) await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName, PolicyDocument: policyDoc(statements) }));
    else if (!created) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName })).catch((e) => {
        if (!missingEntity(e)) throw e;
      });
    }
  }
  if (legacy) await removeLegacy(iam, legacyName, agent);
  if (!role?.Arn) throw new Error(`IAM returned no ARN for ${RoleName}`);
  return { arn: role.Arn, name: RoleName, created };
}

/** Removes what a pre-project role held: the role itself, or for the stack's GitHub role just its unsuffixed policies. */
async function removeLegacy(iam: Iam, RoleName: string, agent: string) {
  if (isGithub(agent)) await deleteAgentRole(iam, RoleName, { keepRole: true, only: Object.values(LEGACY_POLICIES) });
  else await deleteAgentRole(iam, RoleName);
}

/**
 * Removes the agent's role for this project (for the stack's GitHub role, only this project's
 * policies), and a pre-project role that was this project's. Idempotent: what's gone counts as done.
 * False if there was nothing to remove.
 */
export async function removeAgentRole(iam: Iam, s: StackState, project: string, agent: string): Promise<boolean> {
  const RoleName = agentRoleName(project, agent);
  const legacyName = isGithub(agent) ? RoleName : legacyRoleName(agent);
  const legacy = await legacyPolicies(iam, s, legacyName, project, agent);
  const role = await getRole(iam, RoleName);
  if (role && !isGithub(agent) && tagOf(role, AGENT_ROLE.projectTag) !== project) throw new Error(`Role ${RoleName} isn't project ${project}'s; refusing to touch it`);
  const removed = role ? await deleteAgentRole(iam, RoleName, isGithub(agent) ? { keepRole: true, only: Object.values(policyNames(project)) } : {}) : false;
  if (legacy) await removeLegacy(iam, legacyName, agent);
  return removed || Boolean(legacy);
}

/** The agent's role for this project as IAM has it: its ARN and expiry. Undefined if there's none. */
export async function describeAgentRole(iam: Iam, project: string, agent: string): Promise<{ arn: string; expiresAt?: string } | undefined> {
  const role = await getRole(iam, agentRoleName(project, agent));
  if (!role?.Arn) return undefined;
  const expires = tagOf(role, AGENT_ROLE.expiresTag);
  return { arn: role.Arn, ...(expires && expires !== AGENT_ROLE.noExpiry ? { expiresAt: expires } : {}) };
}

export const agentRoleArn = (s: StackState, project: string, agent: string) => `arn:${s.keyArn.split(":")[1]}:iam::${s.account}:role${s.agentRolePath}${agentRoleName(project, agent)}`;

/** Temporary credentials for the agent role, assumed with your credentials. A new role can take a few seconds to work. */
export async function agentCredentials(s: StackState, o: { roleArn?: string; project: string; agent: string; seconds: number; fresh?: boolean; profile?: string }) {
  const roleArn = o.roleArn ?? agentRoleArn(s, o.project, o.agent);
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

/**
 * Removes the role's inline policies (or just `only`), then the role (unless it's one the stack owns).
 * Missing is fine. True if the role was there.
 */
export async function deleteAgentRole(iam: Iam, RoleName: string, o: { keepRole?: boolean; only?: string[] } = {}): Promise<boolean> {
  const { ListRolePoliciesCommand, DeleteRolePolicyCommand, DeleteRoleCommand } = await import("@aws-sdk/client-iam");
  try {
    const { PolicyNames = [] } = await iam.send(new ListRolePoliciesCommand({ RoleName }));
    const doomed = o.only ? PolicyNames.filter((p) => o.only!.includes(p)) : PolicyNames;
    for (const PolicyName of doomed) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName, PolicyName })).catch((e) => {
        if (!missingEntity(e)) throw e;
      });
    }
    if (!o.keepRole) await iam.send(new DeleteRoleCommand({ RoleName }));
    return o.only ? doomed.length > 0 : true;
  } catch (e) {
    if (missingEntity(e)) return false;
    throw e;
  }
}
