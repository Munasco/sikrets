import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Secret } from "./core/secret.ts";
import { state, type Resource } from "./core/state.ts";
import { AGENT_ROLE, AWS_STACK } from "./constants.ts";
import { agentRoleName, policyNames } from "./cloud/aws-stack.ts";

// Self-hosted Sikrets in your AWS account (the cloud provider interface's AWS implementation). AWS is a local HTTP server speaking STS, CloudFormation
// and IAM (Query/XML) and SSM (JSON); the real SDK reaches it through AWS_ENDPOINT_URL_* and signs
// real requests without touching AWS. The fake also plays IAM: a role created without the boundary
// or the sikrets:agent tag is refused, and agent credentials can read only the parameters their
// role's vault policy lists.

const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const STACK = AWS_STACK.defaultName;
const PROJECT = "shop";
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/sikrets-AgentBoundary-XYZ`;
const KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-0000-0000-0000-000000000000`;
const BROKER_ARN = `arn:aws:iam::${ACCOUNT}:role/sikrets-BrokerRole-ABC`;
const GITHUB_ROLE = "sikrets-agent-github-actions";
/** Roles and their inline policies are per project. */
const ROLE = (agent: string, project = PROJECT) => agentRoleName(project, agent);
const POL = policyNames(PROJECT);
const USER = { id: "AKIAUSERUSERUSERUSER", secret: "userSecretValue" };
const CACHE_VALUE = "redis-token-value-1234567890";
const STRIPE_VALUE = "stripe-key-value-0987654321";

interface FakeStack {
  id: string;
  name: string;
  status: string;
  params: Record<string, string>;
  template: string;
  capabilities: string[];
  tags: Record<string, string>;
  describesUntilDone: number;
  failOnCreate?: boolean;
  drift?: string;
}
interface FakeRole {
  name: string;
  path: string;
  arn: string;
  boundary?: string;
  tags: Record<string, string>;
  trust: string;
  policies: Record<string, string>;
}

const keychain = new Map<string, string>();
let home: string;
let root: string;
let cwd: string;
let out: string[];
let err: string[];
let server: ReturnType<typeof Bun.serve>;
let calls: { action: string; params: URLSearchParams; json?: any; signer: string }[];
let stacks: Map<string, FakeStack>;
let roles: Map<string, FakeRole>;
let ssm: Map<string, { value: string; keyId?: string }>;
/** Temporary access key id → the role it was issued for. */
let sessions: Map<string, { roleArn: string; secret: string; token: string }>;
/** IAM actions that fail (AccessDenied, which the SDK doesn't retry) until removed from the set. */
let failing: Set<string>;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL_CLOUDFORMATION", "AWS_ENDPOINT_URL_IAM", "AWS_ENDPOINT_URL_SSM", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "SIKRETS_STACK_TEMPLATE_URL", "SIKRETS_VAULT", "SIKRETS_AGENT"];

const esc = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const ok = (ns: string, action: string, body: string) =>
  new Response(`<${action}Response xmlns="${ns}"><${action}Result>${body}</${action}Result><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata></${action}Response>`, { headers: { "content-type": "text/xml" } });
const fail = (status: number, code: string, message: string) =>
  new Response(`<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${esc(message)}</Message></Error><RequestId>1</RequestId></ErrorResponse>`, { status, headers: { "content-type": "text/xml" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/x-amz-json-1.1" } });
const members = (p: URLSearchParams, prefix: string) => {
  const items: Record<string, string>[] = [];
  for (const [k, v] of p) {
    const m = new RegExp(`^${prefix}\\.member\\.(\\d+)(?:\\.(.+))?$`).exec(k);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    items[i] ??= {};
    items[i]![m[2] ?? "value"] = v;
  }
  return items.filter(Boolean);
};

const STS = "https://sts.amazonaws.com/doc/2011-06-15/";
const CFN = "http://cloudformation.amazonaws.com/doc/2010-05-15/";
const IAM = "https://iam.amazonaws.com/doc/2010-05-08/";

const stackOutputs = (s: FakeStack): Record<string, string> => ({
  [AWS_STACK.outputs.key]: KEY_ARN,
  [AWS_STACK.outputs.vaultPath]: s.params.VaultPath!,
  [AWS_STACK.outputs.boundary]: BOUNDARY_ARN,
  [AWS_STACK.outputs.managerPolicy]: `arn:aws:iam::${ACCOUNT}:policy/sikrets-AgentManagerPolicy-Q`,
  [AWS_STACK.outputs.agentRolePath]: s.params.AgentRolePath!,
  [AWS_STACK.outputs.eventBus]: `${s.name}-events`,
  [AWS_STACK.outputs.eventBusArn]: `arn:aws:events:${REGION}:${ACCOUNT}:event-bus/${s.name}-events`,
  [AWS_STACK.outputs.auditLogGroup]: `/aws/events/${s.name}-audit`,
  ...(s.params.TrustedAccountId ? { [AWS_STACK.outputs.brokerRole]: BROKER_ARN } : {}),
  ...(s.params.GitHubRepository ? { [AWS_STACK.outputs.githubRole]: `arn:aws:iam::${ACCOUNT}:role${AGENT_ROLE.path}${GITHUB_ROLE}` } : {}),
});

const stackXml = (s: FakeStack) => {
  const outputs = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(s.status) ? stackOutputs(s) : {};
  // Like CloudFormation, NoEcho parameters come back masked.
  const shown = { ...s.params, ...(s.params.ExternalId ? { ExternalId: "****" } : {}) };
  return `<member><StackName>${s.name}</StackName><StackId>${s.id}</StackId><StackStatus>${s.status}</StackStatus><CreationTime>2026-11-01T00:00:00Z</CreationTime>
<Parameters>${Object.entries(shown).map(([k, v]) => `<member><ParameterKey>${k}</ParameterKey><ParameterValue>${esc(v)}</ParameterValue></member>`).join("")}</Parameters>
<Outputs>${Object.entries(outputs).map(([k, v]) => `<member><OutputKey>${k}</OutputKey><OutputValue>${esc(v)}</OutputValue></member>`).join("")}</Outputs>
<Tags>${Object.entries(s.tags).map(([k, v]) => `<member><Key>${k}</Key><Value>${esc(v)}</Value></member>`).join("")}</Tags>${s.drift ? `<DriftInformation><StackDriftStatus>${s.drift}</StackDriftStatus></DriftInformation>` : ""}</member>`;
};

const roleXml = (r: FakeRole) =>
  `<Path>${r.path}</Path><RoleName>${r.name}</RoleName><RoleId>AROA${r.name.length}</RoleId><Arn>${r.arn}</Arn><CreateDate>2026-11-01T00:00:00Z</CreateDate><AssumeRolePolicyDocument>${esc(encodeURIComponent(r.trust))}</AssumeRolePolicyDocument>` +
  (r.boundary ? `<PermissionsBoundary><PermissionsBoundaryType>Policy</PermissionsBoundaryType><PermissionsBoundaryArn>${r.boundary}</PermissionsBoundaryArn></PermissionsBoundary>` : "") +
  `<Tags>${Object.entries(r.tags).map(([k, v]) => `<member><Key>${k}</Key><Value>${esc(v)}</Value></member>`).join("")}</Tags>`;

const findStack = (nameOrId: string) => [...stacks.values()].find((s) => s.name === nameOrId || s.id === nameOrId);

/** What CloudFormation would do once a stack finishes: the GitHub Actions role exists iff GitHubRepository is set. */
function applyStack(s: FakeStack) {
  if (s.params.GitHubRepository && !roles.has(GITHUB_ROLE)) {
    roles.set(GITHUB_ROLE, { name: GITHUB_ROLE, path: AGENT_ROLE.path, arn: `arn:aws:iam::${ACCOUNT}:role${AGENT_ROLE.path}${GITHUB_ROLE}`, boundary: BOUNDARY_ARN, tags: { [AGENT_ROLE.tag]: AGENT_ROLE.githubAgent }, trust: "{}", policies: {} });
  }
  if (!s.params.GitHubRepository && roles.get(GITHUB_ROLE) && !Object.keys(roles.get(GITHUB_ROLE)!.policies).length) roles.delete(GITHUB_ROLE);
}

let issued = 0;
function aws(action: string, p: URLSearchParams, signer: string): Response {
  switch (action) {
    case "GetCallerIdentity":
      return ok(STS, action, `<Arn>arn:aws:iam::${ACCOUNT}:user/dev</Arn><UserId>AIDA</UserId><Account>${ACCOUNT}</Account>`);
    case "AssumeRole": {
      const arn = p.get("RoleArn")!;
      const role = [...roles.values()].find((r) => r.arn === arn);
      if (!role || signer !== USER.id) return fail(403, "AccessDenied", "not trusted");
      const id = `ASIAAGENT${String(++issued).padStart(11, "0")}`;
      const c = { roleArn: arn, secret: `agentSecret${issued}`, token: `agentToken${issued}` };
      sessions.set(id, c);
      const exp = new Date(Date.now() + Number(p.get("DurationSeconds")) * 1000).toISOString();
      return ok(STS, action, `<Credentials><AccessKeyId>${id}</AccessKeyId><SecretAccessKey>${c.secret}</SecretAccessKey><SessionToken>${c.token}</SessionToken><Expiration>${exp}</Expiration></Credentials><AssumedRoleUser><Arn>${arn}/${p.get("RoleSessionName")}</Arn><AssumedRoleId>AROA:a</AssumedRoleId></AssumedRoleUser>`);
    }
    case "DescribeStacks": {
      const s = findStack(p.get("StackName")!);
      if (!s || (s.status === "DELETE_COMPLETE" && s.name === p.get("StackName"))) return fail(400, "ValidationError", `Stack with id ${p.get("StackName")} does not exist`);
      if (s.status.endsWith("_IN_PROGRESS") && s.describesUntilDone-- <= 0) {
        s.status = s.failOnCreate ? "ROLLBACK_COMPLETE" : s.status.replace("_IN_PROGRESS", "_COMPLETE");
        if (!s.failOnCreate) applyStack(s);
      }
      return ok(CFN, action, `<Stacks>${stackXml(s)}</Stacks>`);
    }
    case "CreateStack":
    case "UpdateStack": {
      const name = p.get("StackName")!;
      const existing = findStack(name);
      const params = Object.fromEntries(members(p, "Parameters").map((m) => [m.ParameterKey!, m.UsePreviousValue === "true" ? (existing?.params[m.ParameterKey!] ?? "") : (m.ParameterValue ?? "")]));
      if (action === "UpdateStack") {
        if (!existing) return fail(400, "ValidationError", `Stack ${name} does not exist`);
        if (JSON.stringify(existing.params) === JSON.stringify(params) && existing.template === p.get("TemplateBody")) return fail(400, "ValidationError", "No updates are to be performed.");
      }
      const s: FakeStack = existing ?? { id: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/uuid-1`, name, status: "", params: {}, template: "", capabilities: [], tags: {}, describesUntilDone: 0 };
      Object.assign(s, {
        status: action === "CreateStack" ? "CREATE_IN_PROGRESS" : "UPDATE_IN_PROGRESS",
        params,
        template: p.get("TemplateBody") ?? "",
        capabilities: members(p, "Capabilities").map((m) => m.value!),
        tags: Object.fromEntries(members(p, "Tags").map((m) => [m.Key!, m.Value!])),
      });
      stacks.set(s.id, s);
      return ok(CFN, action, `<StackId>${s.id}</StackId>`);
    }
    case "DeleteStack": {
      const s = findStack(p.get("StackName")!);
      if (s) {
        // A role Sikrets made still carrying the boundary blocks deleting it; so does an inline policy on the stack's own role.
        const blocked = [...roles.values()].some((r) => (r.name !== GITHUB_ROLE && r.boundary) || Object.keys(r.policies).length);
        s.status = blocked ? "DELETE_FAILED" : "DELETE_COMPLETE";
        if (!blocked) roles.delete(GITHUB_ROLE);
      }
      return ok(CFN, action, "");
    }
    case "DescribeStackEvents":
      return ok(CFN, action, `<StackEvents><member><StackId>x</StackId><EventId>1</EventId><StackName>${STACK}</StackName><Timestamp>2026-11-01T00:00:00Z</Timestamp><LogicalResourceId>VaultKey</LogicalResourceId><ResourceStatus>CREATE_FAILED</ResourceStatus><ResourceStatusReason>kms says no</ResourceStatusReason></member></StackEvents>`);
    default: {
      // IAM: your own credentials, as in the default (no broker) setup.
      if (signer !== USER.id) return fail(403, "AccessDenied", `${signer} may not call IAM`);
      if (failing.has(action)) return fail(403, "AccessDenied", `${action} refused (test)`);
      const name = p.get("RoleName") ?? "";
      const role = roles.get(name);
      if (action === "GetRole") return role ? ok(IAM, action, `<Role>${roleXml(role)}</Role>`) : fail(404, "NoSuchEntity", `The role with name ${name} cannot be found.`);
      if (action === "CreateRole") {
        const tags = Object.fromEntries(members(p, "Tags").map((m) => [m.Key!, m.Value!]));
        if (p.get("PermissionsBoundary") !== BOUNDARY_ARN || !tags[AGENT_ROLE.tag]) return fail(403, "AccessDenied", "boundary and tag required");
        const r: FakeRole = { name, path: p.get("Path")!, arn: `arn:aws:iam::${ACCOUNT}:role${p.get("Path")}${name}`, boundary: p.get("PermissionsBoundary")!, tags, trust: p.get("AssumeRolePolicyDocument")!, policies: {} };
        roles.set(name, r);
        return ok(IAM, action, `<Role>${roleXml(r)}</Role>`);
      }
      if (action === "ListRoles") {
        const prefix = p.get("PathPrefix") ?? "/";
        return ok(IAM, action, `<Roles>${[...roles.values()].filter((r) => r.path.startsWith(prefix)).map((r) => `<member>${roleXml(r)}</member>`).join("")}</Roles><IsTruncated>false</IsTruncated>`);
      }
      if (!role) return fail(404, "NoSuchEntity", `The role with name ${name} cannot be found.`);
      if (action === "PutRolePolicy") {
        if (role.boundary !== BOUNDARY_ARN) return fail(403, "AccessDenied", "boundary required");
        role.policies[p.get("PolicyName")!] = p.get("PolicyDocument")!;
        return ok(IAM, action, "");
      }
      if (action === "GetRolePolicy") {
        const doc = role.policies[p.get("PolicyName")!];
        return doc ? ok(IAM, action, `<RoleName>${name}</RoleName><PolicyName>${p.get("PolicyName")}</PolicyName><PolicyDocument>${esc(encodeURIComponent(doc))}</PolicyDocument>`) : fail(404, "NoSuchEntity", "no such policy");
      }
      if (action === "TagRole") {
        for (const m of members(p, "Tags")) role.tags[m.Key!] = m.Value!;
        return ok(IAM, action, "");
      }
      if (action === "ListRolePolicies") return ok(IAM, action, `<PolicyNames>${Object.keys(role.policies).map((n) => `<member>${n}</member>`).join("")}</PolicyNames><IsTruncated>false</IsTruncated>`);
      if (action === "DeleteRolePolicy") {
        if (!role.policies[p.get("PolicyName")!]) return fail(404, "NoSuchEntity", "no such policy");
        delete role.policies[p.get("PolicyName")!];
        return ok(IAM, action, "");
      }
      if (action === "DeleteRole") {
        if (Object.keys(role.policies).length) return fail(409, "DeleteConflict", "delete its policies first");
        roles.delete(name);
        return ok(IAM, action, "");
      }
      return fail(400, "InvalidAction", action);
    }
  }
}

/** SSM: you can do anything under the vault path; an agent session only GetParameter on what its role's vault policy lists. */
function ssmCall(target: string, body: any, signer: string): Response {
  const op = target.split(".")[1]!;
  const session = sessions.get(signer);
  if (session) {
    const role = [...roles.values()].find((r) => r.arn === session.roleArn);
    const statements = Object.entries(role?.policies ?? {})
      .filter(([n]) => n.startsWith(AGENT_ROLE.vaultPolicy))
      .flatMap(([, doc]) => JSON.parse(doc).Statement);
    const arn = `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${body.Name}`;
    const live = (s: any) => !s.Condition?.DateLessThan || Date.now() < Date.parse(s.Condition.DateLessThan["aws:CurrentTime"]);
    const allowed = op === "GetParameter" && statements.some((s: any) => s.Action.includes("ssm:GetParameter") && [s.Resource].flat().includes(arn) && live(s));
    if (!allowed) return json({ __type: "AccessDeniedException", message: `${session.roleArn} may not ${op} ${body.Name}` }, 400);
  } else if (signer !== USER.id) return json({ __type: "AccessDeniedException", message: "unknown caller" }, 400);
  if (op === "PutParameter") {
    if (body.Overwrite === false && ssm.has(body.Name)) return json({ __type: "ParameterAlreadyExists", message: "exists" }, 400);
    ssm.set(body.Name, { value: body.Value, keyId: body.KeyId });
    return json({ Version: 1, Tier: "Standard" });
  }
  if (op === "GetParameter") {
    const p = ssm.get(body.Name);
    return p ? json({ Parameter: { Name: body.Name, Type: "SecureString", Value: p.value, Version: 1 } }) : json({ __type: "ParameterNotFound", message: "not found" }, 400);
  }
  if (op === "GetParametersByPath") {
    const prefix = `${body.Path}/`;
    return json({ Parameters: [...ssm].filter(([n]) => n.startsWith(prefix)).map(([Name, p]) => ({ Name, Value: p.value, Type: "SecureString" })) });
  }
  if (op === "DeleteParameter") return ssm.delete(body.Name) ? json({}) : json({ __type: "ParameterNotFound", message: "not found" }, 400);
  return json({ __type: "InvalidAction", message: op }, 400);
}

beforeEach(async () => {
  keychain.clear();
  out = [];
  err = [];
  calls = [];
  stacks = new Map();
  roles = new Map();
  ssm = new Map();
  sessions = new Map();
  failing = new Set();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-stack-home-"));
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-stack-"));
  process.env.SIKRETS_CONFIG_DIR = home;
  server = Bun.serve({
    // Bound to the loopback address the clients use: on a wildcard bind, another process listening on
    // 127.0.0.1 with the same port number could answer instead.
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const signer = /Credential=([A-Z0-9]+)\//.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const target = req.headers.get("x-amz-target");
      if (target) {
        const body = JSON.parse(text);
        calls.push({ action: target.split(".")[1]!, params: new URLSearchParams(), json: body, signer });
        return ssmCall(target, body, signer);
      }
      const params = new URLSearchParams(text);
      const action = params.get("Action")!;
      calls.push({ action, params, signer });
      return aws(action, params, signer);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  Object.assign(process.env, {
    AWS_ENDPOINT_URL_STS: url,
    AWS_ENDPOINT_URL_CLOUDFORMATION: url,
    AWS_ENDPOINT_URL_IAM: url,
    AWS_ENDPOINT_URL_SSM: url,
    AWS_ACCESS_KEY_ID: USER.id,
    AWS_SECRET_ACCESS_KEY: USER.secret,
    AWS_REGION: REGION,
    AWS_CONFIG_FILE: path.join(home, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, "no-aws-credentials"),
  });
  for (const k of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "SIKRETS_STACK_TEMPLATE_URL", "SIKRETS_VAULT", "SIKRETS_AGENT"]) delete process.env[k];
  cwd = process.cwd();
  process.chdir(root);

  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(async () => {
  mock.restore();
  server.stop(true);
  process.chdir(cwd);
  process.exitCode = 0;
  for (const k of ENV_KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const awsCmd = async () => (await import("./commands/aws.ts")).run;
const cloudCmd = async () => (await import("./commands/cloud.ts")).run;
const agentCmd = async () => (await import("./commands/agent.ts")).run;
const printed = () => [...out, ...err].join("\n");
const externalIdInKeychain = () => keychain.get(`dev.sikrets.aws/${AWS_STACK.externalIdAccount(REGION, STACK)}`);
const stateFile = () => path.join(home, AWS_STACK.stateFile);
const actions = () => calls.map((c) => c.action);
const notTTY = () => Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
const connect = async (opts: Record<string, unknown> = {}) => (await cloudCmd())(["connect"], { provider: "aws", region: REGION, ...opts });
const lastJson = () => JSON.parse(out.at(-1)!);
const templateText = () => Bun.file(path.join(import.meta.dir, "../../stack/sikrets.yaml")).text();

/** A project on the aws vault with two secrets stored (sealed) in the stack's Parameter Store. */
async function awsProject() {
  await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: PROJECT, vault: "aws" }));
  const resource = (name: string, key: string): Resource => ({ name, recipe: "anthropic/api-key", provider: "anthropic", strategy: "manual", inputs: {}, dependsOn: {}, envKeys: [key], outputs: {}, applied: true, createdAt: new Date().toISOString() });
  await state.upsert(root, resource("cache", "CACHE_TOKEN"));
  await state.upsert(root, resource("stripe", "STRIPE_KEY"));
  const { openVault } = await import("./core/vault.ts");
  const vault = await openVault(PROJECT, "aws");
  await vault.put("CACHE_TOKEN", Secret.of(CACHE_VALUE));
  await vault.put("STRIPE_KEY", Secret.of(STRIPE_VALUE));
}

describe("aws connect", () => {
  test("creates the stack with your credentials, no broker by default, and records the outputs", async () => {
    await connect();
    const [s] = [...stacks.values()];
    expect(s!.status).toBe("CREATE_COMPLETE");
    expect(s!.template).toBe(await templateText());
    expect(s!.capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(s!.tags).toEqual({ [AWS_STACK.managedByTag]: "sikrets" });
    expect(s!.params).toEqual({ VaultPath: "/sikrets/", AgentRolePath: AGENT_ROLE.path, GitHubRepository: "", CreateGitHubOidcProvider: "true", TrustedAccountId: "", ExternalId: "" });
    expect(calls.find((c) => c.action === "CreateStack")!.signer).toBe(USER.id);
    expect(externalIdInKeychain()).toBeUndefined();

    const st = await Bun.file(stateFile()).json();
    expect(st).toMatchObject({ stackName: STACK, region: REGION, account: ACCOUNT, keyArn: KEY_ARN, vaultPath: "/sikrets/", boundaryArn: BOUNDARY_ARN, agentRolePath: AGENT_ROLE.path, eventBusName: `${STACK}-events` });
    expect(st.brokerRoleArn).toBeUndefined();
    expect(st.githubRoleArn).toBeUndefined();
    expect((await stat(stateFile())).mode & 0o777).toBe(0o600);
    expect(err.join("\n")).toContain(KEY_ARN);
  });

  test("re-running is a no-op; --github-repo adds the GitHub Actions role; the broker is opt-in and off again with none", async () => {
    await connect();
    [...stacks.values()][0]!.params.CreateTrail = "false"; // changed in the console
    await connect({ json: true });
    expect(lastJson()).toMatchObject({ action: "unchanged" });
    expect(calls.findLast((c) => c.action === "UpdateStack")!.params.get("Parameters.member.7.UsePreviousValue")).toBe("true");

    await connect({ "github-repo": "acme/api", "github-oidc-exists": true, json: true });
    expect(lastJson()).toMatchObject({ action: "updated", githubRepository: "acme/api", githubRoleArn: `arn:aws:iam::${ACCOUNT}:role${AGENT_ROLE.path}${GITHUB_ROLE}` });
    expect([...stacks.values()][0]!.params).toMatchObject({ GitHubRepository: "acme/api", CreateGitHubOidcProvider: "false", CreateTrail: "false" });

    await connect({ "broker-account": "999988887777", json: true });
    const ext = externalIdInKeychain()!;
    expect(ext.length).toBeGreaterThanOrEqual(16);
    expect(lastJson()).toMatchObject({ action: "updated", brokerRoleArn: BROKER_ARN, trustedAccount: "999988887777", githubRepository: "acme/api" });
    expect([...stacks.values()][0]!.params).toMatchObject({ TrustedAccountId: "999988887777", ExternalId: ext });
    expect(await Bun.file(stateFile()).text()).not.toContain(ext);

    // Re-running keeps the broker and its external ID (CloudFormation only shows it as ****).
    await connect({ json: true });
    expect(lastJson()).toMatchObject({ action: "unchanged", brokerRoleArn: BROKER_ARN });
    expect(externalIdInKeychain()).toBe(ext);

    await connect({ "broker-account": "none", json: true });
    expect(lastJson().brokerRoleArn).toBeUndefined();
    expect([...stacks.values()][0]!.params).toMatchObject({ TrustedAccountId: "", ExternalId: "" });
    expect(externalIdInKeychain()).toBeUndefined();
    expect(printed()).not.toContain(ext);

    await expect(connect({ "broker-account": "12" })).rejects.toThrow("12-digit");
    await expect(connect({ provider: "gcp" })).rejects.toThrow("isn't available yet");
    await expect(connect({ "github-repo": "not a repo" })).rejects.toThrow("owner/repo");
  });

  test("sikrets aws connect|disconnect is the same as cloud --provider aws", async () => {
    await (await awsCmd())(["connect"], { region: REGION, json: true });
    expect(lastJson()).toMatchObject({ provider: "aws", action: "created", stackName: STACK });
    await (await awsCmd())(["disconnect"], { yes: true, json: true });
    expect(lastJson()).toMatchObject({ provider: "aws", deleted: STACK });
    expect(await Bun.file(stateFile()).exists()).toBe(false);
  });

  test("waits while CloudFormation works, and reports why a failed stack failed", async () => {
    const { deployStack } = await import("./cloud/aws-stack.ts");
    const log: string[] = [];
    const wrap = (after: (s: FakeStack) => void) =>
      server.reload({
        async fetch(req) {
          const params = new URLSearchParams(await req.text());
          const action = params.get("Action")!;
          const res = aws(action, params, USER.id);
          if (action === "CreateStack") after([...stacks.values()][0]!);
          return res;
        },
      });
    wrap((s) => (s.describesUntilDone = 2));
    const s = await deployStack({ region: REGION, stackName: STACK, log: (m) => log.push(m), pollMs: 1 });
    expect(s.action).toBe("created");
    expect(log.filter((l) => l.includes("CREATE_IN_PROGRESS"))).toHaveLength(1);
    expect(log.at(-1)).toContain("CREATE_COMPLETE");

    stacks.clear();
    wrap((s) => (s.failOnCreate = true));
    await expect(deployStack({ region: REGION, stackName: STACK, log: () => {}, pollMs: 1 })).rejects.toThrow("ROLLBACK_COMPLETE: VaultKey: kms says no");
    await expect(deployStack({ region: REGION, stackName: STACK, log: () => {}, pollMs: 1 })).rejects.toThrow("sikrets cloud disconnect");
  });

  test("--link prints a quick-create URL and deploys nothing", async () => {
    const query = () => new URLSearchParams(out.at(-1)!.split("quickcreate?")[1]);
    await connect({ link: true });
    expect(query().get("templateURL")).toBe(AWS_STACK.templateUrl);
    await connect({ link: true, "template-url": "https://bucket.s3.amazonaws.com/sikrets.yaml", "github-repo": "acme/api" });
    expect(out.at(-1)).toStartWith(`https://console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks/quickcreate?`);
    expect(Object.fromEntries(query())).toEqual({
      templateURL: "https://bucket.s3.amazonaws.com/sikrets.yaml",
      stackName: STACK,
      param_VaultPath: "/sikrets/",
      param_AgentRolePath: AGENT_ROLE.path,
      param_GitHubRepository: "acme/api",
      param_CreateGitHubOidcProvider: "true",
    });
    await connect({ link: true, "template-url": "https://bucket.s3.amazonaws.com/sikrets.yaml", "broker-account": "999988887777" });
    expect(query().get("param_TrustedAccountId")).toBe("999988887777");
    expect(query().get("param_ExternalId")).toBe(externalIdInKeychain()!);
    expect(actions()).not.toContain("CreateStack");
  });
});

describe("aws vault", () => {
  beforeEach(() => connect());

  test("stores sealed sk1: envelopes as SecureStrings under the stack's KMS key", async () => {
    await awsProject();
    const stored = ssm.get(`/sikrets/${PROJECT}/CACHE_TOKEN`)!;
    expect(stored.keyId).toBe(KEY_ARN);
    expect(stored.value).toStartWith("sk1:");
    expect(stored.value).not.toContain(CACHE_VALUE);
    const { openVault } = await import("./core/vault.ts");
    expect((await (await openVault(PROJECT, "aws")).get("CACHE_TOKEN"))!.reveal()).toBe(CACHE_VALUE);
  });

  test("needs a connected stack", async () => {
    await (await import("./core/fs.ts")).remove(stateFile());
    const { openVault } = await import("./core/vault.ts");
    await expect(openVault(PROJECT, "aws")).rejects.toThrow("sikrets cloud connect");
  });
});

describe("agents in the stack", () => {
  beforeEach(async () => {
    await connect();
    await awsProject();
    calls = [];
  });

  test("agent add creates the agent's own role: under the boundary, tagged, reading only its secrets until it expires", async () => {
    await (await agentCmd())(["add", "reporter"], { key: ["cache"], expires: "7d", allow: ["s3:GetObject=arn:aws:s3:::reports/*"], json: true });
    const role = roles.get(ROLE("reporter"))!;
    const expiresAt = lastJson().expiresAt;
    expect(lastJson()).toMatchObject({ name: "reporter", scope: ["cache"], identity: role.arn, cloudIdentity: { status: "ready", id: role.arn } });
    expect(role.name).toMatch(/^sikrets-agent-reporter-[0-9a-f]{8}$/);
    expect(role.path).toBe(AGENT_ROLE.path);
    expect(role.boundary).toBe(BOUNDARY_ARN);
    expect(role.tags).toEqual({ [AGENT_ROLE.tag]: "reporter", [AGENT_ROLE.projectTag]: PROJECT, [AGENT_ROLE.expiresTag]: expiresAt, [AWS_STACK.managedByTag]: "sikrets" });
    expect(JSON.parse(role.trust).Statement[0].Principal).toEqual({ AWS: [`arn:aws:iam::${ACCOUNT}:root`] });

    expect(JSON.parse(role.policies[POL.vault]!).Statement).toEqual([
      { Effect: "Allow", Action: ["ssm:GetParameter", "ssm:GetParameters"], Resource: [`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/sikrets/${PROJECT}/CACHE_TOKEN`], Condition: { DateLessThan: { "aws:CurrentTime": expiresAt } } },
      { Effect: "Allow", Action: ["kms:Decrypt"], Resource: KEY_ARN, Condition: { StringEquals: { "kms:ViaService": `ssm.${REGION}.amazonaws.com` }, DateLessThan: { "aws:CurrentTime": expiresAt } } },
    ]);
    // --allow permissions end when the agent does, too.
    expect(JSON.parse(role.policies[POL.allow]!).Statement).toEqual([{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "arn:aws:s3:::reports/*", Condition: { DateLessThan: { "aws:CurrentTime": expiresAt } } }]);
    expect(calls.filter((c) => ["CreateRole", "PutRolePolicy"].includes(c.action)).every((c) => c.signer === USER.id)).toBe(true);
  });

  test("run --agent reads the agent's secrets with its own temporary credentials; IAM refuses the rest", async () => {
    await (await agentCmd())(["add", "reporter"], { key: ["cache"] });
    calls = [];
    const file = path.join(root, "out.txt");
    await (await import("./commands/run.ts")).run(["sh", "-c", `printf %s "$CACHE_TOKEN|$STRIPE_KEY" > ${file}`], { agent: "reporter" });
    expect(await Bun.file(file).text()).toBe(`${CACHE_VALUE}|`);

    const assume = calls.find((c) => c.action === "AssumeRole")!;
    expect(assume.params.get("RoleArn")).toBe(roles.get(ROLE("reporter"))!.arn);
    expect(assume.params.get("DurationSeconds")).toBe("900");
    expect(assume.params.get("RoleSessionName")).toBe("sikrets-reporter");
    const read = calls.find((c) => c.action === "GetParameter")!;
    expect(read.signer).toStartWith("ASIAAGENT");
    expect(read.json.Name).toBe(`/sikrets/${PROJECT}/CACHE_TOKEN`);

    // Even past the CLI's own scope check, the role can't read a secret outside its scope.
    const { openVault } = await import("./core/vault.ts");
    const { agentVaultCredentials } = await import("./commands/agent-role.ts");
    const { agents } = await import("./core/agents.ts");
    const ctx = { root, project: PROJECT, vault: "aws" as const, requireSealed: false, dryRun: false, log: () => {} };
    const asAgent = await openVault(PROJECT, "aws", { as: await agentVaultCredentials(ctx, (await agents.find(root, "reporter"))!) });
    await expect(asAgent.get("STRIPE_KEY")).rejects.toThrow("may not GetParameter");
    await expect(asAgent.put("CACHE_TOKEN", Secret.of("x"))).rejects.toThrow();
    expect(printed()).not.toContain(CACHE_VALUE);
  });

  test("agent revoke deletes the role; other agents keep theirs", async () => {
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"] });
    await run(["add", "billing"], { key: ["stripe"] });
    await run(["revoke", "reporter"], { json: true });
    expect(lastJson()).toMatchObject({ name: "reporter", identityRemoved: true });
    expect([...roles.keys()]).toEqual([ROLE("billing")]);
    await expect((await import("./commands/run.ts")).run(["true"], { agent: "reporter" })).rejects.toThrow("revoked");
  });

  test("GitHub Actions is an agent too: the stack's role gets only the secrets you grant", async () => {
    await connect({ "github-repo": "acme/api" });
    calls = [];
    await (await agentCmd())(["add", AGENT_ROLE.githubAgent], { key: ["stripe"] });
    expect(actions()).not.toContain("CreateRole");
    expect(JSON.parse(roles.get(GITHUB_ROLE)!.policies[POL.vault]!).Statement[0].Resource).toEqual([`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/sikrets/${PROJECT}/STRIPE_KEY`]);
    await (await agentCmd())(["revoke", AGENT_ROLE.githubAgent], {});
    expect(roles.get(GITHUB_ROLE)!.policies).toEqual({}); // permissions gone, the stack's role stays
  });

  test("other vaults keep working without roles, and refuse --allow", async () => {
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: PROJECT, vault: "keychain" }));
    await expect((await agentCmd())(["add", "reporter"], { key: ["cache"], allow: ["s3:GetObject"] })).rejects.toThrow("needs a cloud vault");
    await (await agentCmd())(["add", "reporter"], { key: ["cache"] });
    expect(roles.size).toBe(0);
  });
});

describe("agent role", () => {
  beforeEach(async () => {
    await connect();
    await awsProject();
    calls = [];
  });

  test("hands a command only the role's temporary credentials, for --ttl", async () => {
    const file = path.join(root, "creds.txt");
    const run = await agentCmd();
    await run(["role", "builder", "sh", "-c", `printf %s "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY:$AWS_SESSION_TOKEN" > ${file}`], {
      allow: ["s3:GetObject,s3:ListBucket=arn:aws:s3:::reports/*", "s3:ListAllMyBuckets", "s3:PutObject=arn:aws:s3:::reports/*"],
      ttl: "30m",
    });
    const role = roles.get(ROLE("builder"))!;
    expect(role.boundary).toBe(BOUNDARY_ARN);
    expect(JSON.parse(role.policies[POL.allow]!).Statement).toEqual([
      { Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"], Resource: "arn:aws:s3:::reports/*" },
      { Effect: "Allow", Action: ["s3:ListAllMyBuckets"], Resource: "*" },
    ]);
    const assume = calls.find((c) => c.action === "AssumeRole")!;
    expect(assume.params.get("DurationSeconds")).toBe("1800");
    const [id, c] = [...sessions][0]!;
    expect(await Bun.file(file).text()).toBe(`${id}:${c.secret}:${c.token}`);
    for (const secret of [c.secret, c.token, USER.secret]) expect(printed()).not.toContain(secret);
  });

  test("an agent's role from agent add is reused, and credentials default to 15 minutes", async () => {
    notTTY();
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"] });
    calls = [];
    await run(["role", "reporter"], { env: true });
    expect(actions()).toEqual(["GetRole", "GetRole", "AssumeRole"]); // its role, and a pre-project one to take over (none)
    expect(calls[2]!.params.get("DurationSeconds")).toBe(String(15 * 60));
    expect(out.at(-1)).toContain("export AWS_ACCESS_KEY_ID='ASIAAGENT");
    await run(["revoke", "reporter"], {});
    await expect(run(["role", "reporter"], { env: true })).rejects.toThrow("revoked");
  });

  test("refuses before calling AWS: bad --allow, out-of-range --ttl, nowhere to deliver, bad name", async () => {
    const run = await agentCmd();
    await expect(run(["role", "builder", "true"], { allow: ["iam:PassRole"] })).rejects.toThrow("permissions boundary denies it");
    await expect(run(["role", "builder", "true"], { allow: ["s3:GetObject=bucket"] })).rejects.toThrow("must be an ARN");
    await expect(run(["role", "builder", "true"], { allow: ["GetObject"] })).rejects.toThrow("isn't an IAM action");
    await expect(run(["role", "builder", "true"], { allow: ["s3:GetObject"], ttl: "2h" })).rejects.toThrow("15m to 60m");
    await expect(run(["role", "builder"], { allow: ["s3:GetObject"] })).rejects.toThrow("Say where the credentials go");
    await expect(run(["role", "Bad_Name", "true"], {})).rejects.toThrow("Invalid agent name");
    expect(calls).toHaveLength(0);
    await expect(run(["role", "builder", "true"], {})).rejects.toThrow("has no role yet");
    expect(roles.size).toBe(0);
  });

  test("won't touch a same-named role that isn't a Sikrets agent role", async () => {
    roles.set(ROLE("builder"), { name: ROLE("builder"), path: AGENT_ROLE.path, arn: `arn:aws:iam::${ACCOUNT}:role/x`, tags: {}, trust: "{}", policies: {} });
    await expect((await agentCmd())(["role", "builder", "true"], { allow: ["s3:GetObject"] })).rejects.toThrow("refusing to touch it");
    expect(actions()).not.toContain("PutRolePolicy");
  });

  test("--revoke deletes the role and its policies", async () => {
    const run = await agentCmd();
    await run(["role", "builder", "true"], { allow: ["s3:GetObject"] });
    await run(["role", "builder"], { revoke: true });
    expect(roles.size).toBe(0);
    expect(actions().slice(-3)).toEqual(["ListRolePolicies", "DeleteRolePolicy", "DeleteRole"]);
    await expect(run(["role", "builder"], { revoke: true })).rejects.toThrow("has no identity");
  });
});

describe("aws disconnect", () => {
  test("removes every agent role, then the stack, and forgets it", async () => {
    await connect({ "github-repo": "acme/api" });
    await awsProject();
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"] });
    await run(["add", AGENT_ROLE.githubAgent], { key: ["stripe"] });
    await run(["role", "builder", "true"], { allow: ["ecr:GetAuthorizationToken"] });

    await expect((await cloudCmd())(["disconnect"], {})).rejects.toThrow("--yes");
    expect(roles.size).toBe(3);

    await (await cloudCmd())(["disconnect"], { yes: true, json: true });
    expect(lastJson()).toEqual({ provider: "aws", deleted: STACK, agentIdentities: [GITHUB_ROLE, ROLE("reporter"), ROLE("builder")] });
    expect([...stacks.values()][0]!.status).toBe("DELETE_COMPLETE");
    expect(roles.size).toBe(0);
    expect(actions().indexOf("DeleteStack")).toBeGreaterThan(actions().lastIndexOf("DeleteRole"));
    expect(calls.find((c) => c.action === "DeleteStack")!.signer).toBe(USER.id);
    expect(await Bun.file(stateFile()).exists()).toBe(false);
    await expect((await cloudCmd())(["disconnect"], { yes: true })).rejects.toThrow("nothing to disconnect");
  });
});

describe("agent identity lifecycle", () => {
  beforeEach(async () => {
    await connect();
    await awsProject();
    calls = [];
  });
  const stored = async (name: string) => (await (await import("./core/agents.ts")).agents.find(root, name))!;

  test("revoke: an IAM failure leaves the agent revoked and its role marked removing; a re-run finishes", async () => {
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"] });
    failing.add("DeleteRole");
    await expect(run(["revoke", "reporter"], {})).rejects.toThrow("DeleteRole refused");
    expect(await stored("reporter")).toMatchObject({ status: "revoked", cloudIdentity: { status: "removing" } });
    expect(roles.has(ROLE("reporter"))).toBe(true);
    // Already revoked locally, so nothing more is handed out meanwhile.
    await expect((await import("./commands/run.ts")).run(["true"], { agent: "reporter" })).rejects.toThrow("revoked");

    failing.clear();
    await run(["revoke", "reporter"], { json: true });
    expect(lastJson()).toMatchObject({ status: "revoked", identityRemoved: true, cloudIdentity: { status: "removed" } });
    expect(roles.has(ROLE("reporter"))).toBe(false);
    await run(["revoke", "reporter"], {});
    expect(printed()).toContain("already revoked");
  });

  test("revoke retries for a record revoked before identities were tracked", async () => {
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"] });
    // What the old order could leave: revoked locally, role still in AWS.
    const file = path.join(root, ".sikrets/agents.json");
    const all = await Bun.file(file).json();
    await Bun.write(file, JSON.stringify(all.map(({ cloudIdentity: _, ...a }: any) => ({ ...a, status: "revoked", revokedAt: new Date().toISOString() }))));
    await run(["revoke", "reporter"], {});
    expect(roles.has(ROLE("reporter"))).toBe(false);
    expect((await stored("reporter")).cloudIdentity?.status).toBe("removed");
  });

  test("agent role --revoke on this project's agent revokes it, so agents.json never says active for a deleted role", async () => {
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"] });
    await run(["role", "reporter"], { revoke: true });
    expect(roles.has(ROLE("reporter"))).toBe(false);
    expect(await stored("reporter")).toMatchObject({ status: "revoked", cloudIdentity: { status: "removed" } });
  });

  test("add records the agent before creating its role; a failed create is resumed, never orphaned", async () => {
    const run = await agentCmd();
    failing.add("CreateRole");
    await expect(run(["add", "reporter"], { key: ["cache"] })).rejects.toThrow("CreateRole refused");
    expect(await stored("reporter")).toMatchObject({ status: "active", cloudIdentity: { status: "pending" } });
    expect(roles.size).toBe(0);
    failing.clear();
    await run(["add", "reporter"], { key: ["cache"], json: true });
    expect(lastJson().cloudIdentity).toMatchObject({ status: "ready", id: roles.get(ROLE("reporter"))!.arn });
    expect((await (await import("./core/agents.ts")).agents.load(root)).filter((a) => a.name === "reporter")).toHaveLength(1);
    await expect(run(["add", "reporter"], { key: ["cache"] })).rejects.toThrow("already exists");
  });

  test("credentials never outlive the agent: the lease is cut to its expiry", async () => {
    const run = await agentCmd();
    await run(["add", "reporter"], { key: ["cache"], expires: "20m" });
    notTTY();
    calls = [];
    await run(["role", "reporter"], { env: true, ttl: "60m" });
    const seconds = Number(calls.find((c) => c.action === "AssumeRole")!.params.get("DurationSeconds"));
    expect(seconds).toBeLessThanOrEqual(20 * 60);
    expect(seconds).toBeGreaterThan(18 * 60);
  });

  test("agent role checks expiry from the role itself for agents not in this folder's agents.json", async () => {
    const run = await agentCmd();
    await run(["role", "builder", "true"], { allow: ["s3:GetObject"] });
    expect(roles.get(ROLE("builder"))!.tags[AGENT_ROLE.expiresTag]).toBe(AGENT_ROLE.noExpiry);
    roles.get(ROLE("builder"))!.tags[AGENT_ROLE.expiresTag] = new Date(Date.now() - 1000).toISOString();
    calls = [];
    await expect(run(["role", "builder", "true"], {})).rejects.toThrow("expired");
    expect(actions()).not.toContain("AssumeRole");
  });

  test("the same agent name in two projects gets two roles; revoking one leaves the other", async () => {
    const run = await agentCmd();
    await run(["add", "claude"], { key: ["cache"] });
    const other = await mkdtemp(path.join(os.tmpdir(), "sikrets-other-"));
    try {
      await Bun.write(path.join(other, "sikrets.json"), JSON.stringify({ project: "blog", vault: "aws" }));
      const resource: Resource = { name: "cache", recipe: "anthropic/api-key", provider: "anthropic", strategy: "manual", inputs: {}, dependsOn: {}, envKeys: ["CACHE_TOKEN"], outputs: {}, applied: true, createdAt: new Date().toISOString() };
      await state.upsert(other, resource);
      process.chdir(other);
      await run(["add", "claude"], { key: ["cache"] });
      expect(roles.has(ROLE("claude", "blog"))).toBe(true);
      expect(roles.get(ROLE("claude", "blog"))!.tags[AGENT_ROLE.projectTag]).toBe("blog");
      process.chdir(root);
      await run(["revoke", "claude"], {});
      expect(roles.has(ROLE("claude"))).toBe(false);
      const blog = JSON.parse(Object.values(roles.get(ROLE("claude", "blog"))!.policies)[0]!);
      expect(blog.Statement[0].Resource).toEqual([`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/sikrets/blog/CACHE_TOKEN`]);
    } finally {
      process.chdir(root);
      await rm(other, { recursive: true, force: true });
    }
  });

  test("a role from before roles were per project is taken over by its project, and left alone by others", async () => {
    const legacy = (agent: string, project: string) => {
      const vault = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [`arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/sikrets/${project}/CACHE_TOKEN`] }] };
      const allow = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }] };
      const name = `${AGENT_ROLE.namePrefix}${agent}`;
      roles.set(name, { name, path: AGENT_ROLE.path, arn: `arn:aws:iam::${ACCOUNT}:role${AGENT_ROLE.path}${name}`, boundary: BOUNDARY_ARN, tags: { [AGENT_ROLE.tag]: agent }, trust: "{}", policies: { [AGENT_ROLE.vaultPolicy]: JSON.stringify(vault), [AGENT_ROLE.allowPolicy]: JSON.stringify(allow) } });
    };
    legacy("reporter", PROJECT);
    legacy("someone", "blog");
    // An agents.json record from before: no cloud identity state.
    await Bun.write(path.join(root, ".sikrets/agents.json"), JSON.stringify([{ name: "reporter", scope: ["cache"], createdAt: new Date().toISOString() }, { name: "someone", scope: ["cache"], createdAt: new Date().toISOString() }]));

    const file = path.join(root, "out.txt");
    await (await import("./commands/run.ts")).run(["sh", "-c", `printf %s "$CACHE_TOKEN" > ${file}`], { agent: "reporter" });
    expect(await Bun.file(file).text()).toBe(CACHE_VALUE);
    expect(roles.has("sikrets-agent-reporter")).toBe(false);
    const migrated = roles.get(ROLE("reporter"))!;
    expect(JSON.parse(migrated.policies[POL.allow]!).Statement[0].Action).toEqual(["s3:GetObject"]); // carried over
    expect((await stored("reporter")).cloudIdentity?.status).toBe("ready");

    // blog's old role isn't this project's: untouched.
    await (await import("./commands/run.ts")).run(["true"], { agent: "someone" });
    expect(roles.has("sikrets-agent-someone")).toBe(true);
  });
});

describe("stack status", () => {
  const status = async () => {
    await (await cloudCmd())(["status"], { provider: "aws", json: true });
    return lastJson();
  };
  const recorded = async () => (await Bun.file(stateFile()).json()).status;

  test("a failed first create is recorded as failed, and disconnect removes it", async () => {
    server.reload({
      async fetch(req) {
        const text = await req.text();
        const params = new URLSearchParams(text);
        const action = params.get("Action")!;
        calls.push({ action, params, signer: USER.id });
        const res = aws(action, params, USER.id);
        if (action === "CreateStack") [...stacks.values()][0]!.failOnCreate = true;
        return res;
      },
    });
    await expect(connect()).rejects.toThrow("ROLLBACK_COMPLETE");
    expect(await recorded()).toBe("failed");
    await expect(connect()).rejects.toThrow("sikrets cloud disconnect --yes");
    expect(await status()).toMatchObject({ status: "failed", detail: "ROLLBACK_COMPLETE" });
    await (await cloudCmd())(["disconnect"], { yes: true, json: true });
    expect(lastJson()).toMatchObject({ deleted: STACK });
    expect([...stacks.values()][0]!.status).toBe("DELETE_COMPLETE");
    expect(await Bun.file(stateFile()).exists()).toBe(false);
  });

  test("disconnect --stack removes a Sikrets stack that isn't recorded here, and refuses one that isn't ours", async () => {
    await connect();
    await (await import("./core/fs.ts")).remove(stateFile());
    await expect((await cloudCmd())(["disconnect"], { yes: true })).rejects.toThrow("--stack NAME");
    await (await cloudCmd())(["disconnect"], { yes: true, stack: STACK, json: true });
    expect([...stacks.values()][0]!.status).toBe("DELETE_COMPLETE");

    stacks.set("x", { id: "arn:aws:cloudformation:us-east-1:111122223333:stack/theirs/uuid", name: "theirs", status: "CREATE_COMPLETE", params: { VaultPath: "/x/", AgentRolePath: "/x/" }, template: "", capabilities: [], tags: {}, describesUntilDone: 0 });
    await expect((await cloudCmd())(["disconnect"], { yes: true, stack: "theirs" })).rejects.toThrow("isn't a Sikrets stack");
  });

  test("a no-op update after a failed update leaves a usable, rolled-back stack instead of throwing", async () => {
    await connect();
    [...stacks.values()][0]!.status = "UPDATE_ROLLBACK_COMPLETE";
    await connect({ json: true });
    expect(lastJson()).toMatchObject({ action: "unchanged", status: "rolled-back", cfnStatus: "UPDATE_ROLLBACK_COMPLETE", keyArn: KEY_ARN });
    await awsProject(); // the vault still works
  });

  test("connecting a second stack is refused while the first exists; allowed once it's gone", async () => {
    await connect();
    await expect(connect({ stack: "second" })).rejects.toThrow(`Already connected to stack ${STACK}`);
    expect(stacks.size).toBe(1);
    [...stacks.values()][0]!.status = "DELETE_COMPLETE"; // deleted in the console
    await connect({ stack: "second", json: true });
    expect(lastJson()).toMatchObject({ action: "created", stackName: "second" });
  });

  test("a stack deleted outside Sikrets is reported as such, by status and by commands that need it", async () => {
    await connect();
    await awsProject();
    await (await agentCmd())(["add", "reporter"], { key: ["cache"] });
    [...stacks.values()][0]!.status = "DELETE_COMPLETE";
    roles.clear();
    await expect((await import("./commands/run.ts")).run(["true"], { agent: "reporter" })).rejects.toThrow("deleted outside Sikrets");
    expect(await status()).toMatchObject({ status: "deleted-outside" });
    // Revoking still works: the role went with the stack.
    await (await agentCmd())(["revoke", "reporter"], {});
    expect((await (await import("./core/agents.ts")).agents.find(root, "reporter"))!.cloudIdentity?.status).toBe("removed");
    await (await cloudCmd())(["disconnect"], { yes: true, json: true });
    expect(lastJson()).toMatchObject({ forgotten: true });
    expect(await Bun.file(stateFile()).exists()).toBe(false);
  });

  test("a settle timeout leaves 'creating' on disk; the next command checks CloudFormation and carries on", async () => {
    const { deployStack } = await import("./cloud/aws-stack.ts");
    server.reload({
      async fetch(req) {
        const params = new URLSearchParams(await req.text());
        const action = params.get("Action")!;
        const res = aws(action, params, USER.id);
        if (action === "CreateStack") [...stacks.values()][0]!.describesUntilDone = 1_000;
        return res;
      },
    });
    await expect(deployStack({ region: REGION, stackName: STACK, log: () => {}, pollMs: 1, timeoutMs: 20 })).rejects.toThrow("Timed out");
    expect(await recorded()).toBe("creating");
    await expect((await import("./cloud/aws-stack.ts")).connectedStack()).rejects.toThrow("is creating");
    [...stacks.values()][0]!.describesUntilDone = 0;
    const s = await (await import("./cloud/aws-stack.ts")).connectedStack();
    expect(s).toMatchObject({ status: "ready", keyArn: KEY_ARN });
  });

  test("drift is reported, and a drifted stack stays usable", async () => {
    await connect();
    [...stacks.values()][0]!.drift = "DRIFTED";
    expect(await status()).toMatchObject({ status: "drifted", name: STACK });
    await awsProject();
  });

  test("a state file from before statuses were recorded loads as ready", async () => {
    await connect();
    const { status: _, cfnStatus: __, checkedAt: ___, ...old } = await Bun.file(stateFile()).json();
    await Bun.write(stateFile(), JSON.stringify(old));
    expect(await (await import("./cloud/aws-stack.ts")).connectedStack()).toMatchObject({ status: "ready" });
  });
});

describe("stack template", () => {
  // Bun's YAML parser drops CloudFormation's short tags (!Ref X parses as "X"), which is enough to
  // check structure; references are checked on the text below.
  const parsed = async () => Bun.YAML.parse(await templateText()) as Record<string, Record<string, any>>;

  test("parses, every resource has a type, and there's no compute", async () => {
    const t = await parsed();
    expect(t.AWSTemplateFormatVersion as unknown).toBe("2010-09-09");
    const types = Object.fromEntries(Object.entries(t.Resources!).map(([k, v]) => [k, v.Type]));
    expect(types).toMatchObject({
      VaultKey: "AWS::KMS::Key",
      AgentBoundary: "AWS::IAM::ManagedPolicy",
      AgentManagerPolicy: "AWS::IAM::ManagedPolicy",
      BrokerRole: "AWS::IAM::Role",
      GitHubOidcProvider: "AWS::IAM::OIDCProvider",
      GitHubActionsRole: "AWS::IAM::Role",
      EventBus: "AWS::Events::EventBus",
      SecretAccessRule: "AWS::Events::Rule",
      AuditLogGroup: "AWS::Logs::LogGroup",
      Trail: "AWS::CloudTrail::Trail",
    });
    expect(Object.values(types).some((x) => /^AWS::(EC2|ECS|Lambda)::/.test(String(x)))).toBe(false);
  });

  test("has no null values (CloudFormation rejects them; an unquoted comma in a { } map makes one)", async () => {
    const nulls: string[] = [];
    const walk = (v: unknown, at: string) => {
      if (v === null) nulls.push(at);
      else if (typeof v === "object") for (const [k, x] of Object.entries(v as object)) walk(x, `${at}/${k}`);
    };
    walk(await parsed(), "");
    expect(nulls).toEqual([]);
  });

  test("every Ref, GetAtt, Condition and ${} names something defined", async () => {
    const t = await parsed();
    const known = new Set([...Object.keys(t.Parameters!), ...Object.keys(t.Resources!), "AWS::AccountId", "AWS::Region", "AWS::Partition", "AWS::StackName", "AWS::StackId", "AWS::NoValue"]);
    const body = await templateText();
    const refs = [
      ...[...body.matchAll(/!Ref\s+([\w:]+)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/!GetAtt\s+(\w+)\./g)].map((m) => m[1]!),
      ...[...body.matchAll(/\$\{([\w:]+)(?:\.\w+)?\}/g)].map((m) => m[1]!),
    ];
    expect(refs.length).toBeGreaterThan(30);
    expect(refs.filter((r) => !known.has(r))).toEqual([]);
    const conditions = new Set(Object.keys(t.Conditions!));
    for (const m of body.matchAll(/!Condition\s+(\w+)|\[(\w+), !GetAtt/g)) expect(conditions.has((m[1] ?? m[2])!)).toBe(true);
    for (const r of [...Object.values(t.Resources!), ...Object.values(t.Outputs!)]) if (r.Condition) expect(conditions.has(r.Condition)).toBe(true);
  });

  test("matches what the CLI passes and reads", async () => {
    const t = await parsed();
    for (const p of Object.values(AWS_STACK.params)) expect(t.Parameters![p]).toBeDefined();
    for (const o of Object.values(AWS_STACK.outputs)) expect(t.Outputs![o]).toBeDefined();
    expect(t.Parameters!.AgentRolePath!.Default).toBe(AGENT_ROLE.path);
    expect(t.Parameters!.VaultPath!.Default).toBe("/sikrets/");
    expect(t.Parameters!.TrustedAccountId!.Default).toBe(""); // broker off by default
    expect(t.Parameters!.ExternalId!.NoEcho).toBe(true);
    expect(t.Resources!.GitHubActionsRole!.Properties.RoleName).toBe(`${AGENT_ROLE.namePrefix}${AGENT_ROLE.githubAgent}`);
    expect(t.Resources!.GitHubActionsRole!.Properties.Tags).toContainEqual({ Key: AGENT_ROLE.tag, Value: AGENT_ROLE.githubAgent });
  });

  test("the key works only through SSM, agents can't write the vault or escape the boundary", async () => {
    const t = await parsed();
    const keyPolicy = t.Resources!.VaultKey!.Properties.KeyPolicy.Statement as any[];
    expect(keyPolicy.find((s) => s.Sid === "AccountManagesTheKey").Action).not.toContain("kms:Decrypt");
    expect(Object.keys(keyPolicy.find((s) => s.Sid === "AccountUsesTheKeyThroughSsmOnly").Condition.StringEquals)).toContain("kms:ViaService");
    const boundary = t.Resources!.AgentBoundary!.Properties.PolicyDocument.Statement as any[];
    const denied = boundary.filter((s) => s.Effect === "Deny").flatMap((s) => [s.Action ?? []].flat());
    for (const service of AGENT_ROLE.deniedServices) expect(denied.some((a: string) => a.startsWith(`${service}:`))).toBe(true);
    expect(denied).toContain("ssm:PutParameter");
    expect(boundary.find((s) => s.Sid === "VaultKeyDecryptOnly").NotAction).toBe("kms:Decrypt");
    const manager = t.Resources!.AgentManagerPolicy!.Properties.PolicyDocument.Statement as any[];
    const create = manager.find((s) => s.Action === "iam:CreateRole");
    expect(Object.keys(create.Condition.StringEquals)).toEqual(["iam:PermissionsBoundary"]);
    expect(create.Condition.Null[`aws:RequestTag/${AGENT_ROLE.tag}`]).toBe("false");
    const github = t.Resources!.GitHubActionsRole!.Properties;
    expect(github.Policies).toBeUndefined(); // starts with nothing
    expect(Object.keys(github.AssumeRolePolicyDocument.Statement[0].Condition)).toEqual(["StringEquals", "StringLike"]);
    expect(t.Resources!.BrokerRole!.Condition).toBe("HasBroker");
    expect(t.Resources!.SecretAccessRule!.Properties.State).toBe("ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS");
  });
});
