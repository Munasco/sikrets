import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_ROLE, AWS_STACK } from "./constants.ts";

// The Sikrets stack in your AWS account. AWS is a local HTTP server speaking the Query protocol
// for STS, CloudFormation and IAM (the SDK reaches it through AWS_ENDPOINT_URL_*), so the real SDK
// signs and sends real requests without touching AWS. The fake also enforces what the template
// enforces: the broker needs the external ID, and agent roles need the boundary and the tag.

const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const STACK = AWS_STACK.defaultName;
const BROKER_ARN = `arn:aws:iam::${ACCOUNT}:role/sikrets-BrokerRole-ABC`;
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/sikrets-AgentBoundary-XYZ`;
const KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/1234abcd-0000-0000-0000-000000000000`;
// Fake temporary credentials; distinct per issuer so tests can see who signed what.
const USER = { id: "AKIAUSERUSERUSERUSER", secret: "userSecretValue" };
const BROKER = { id: "ASIABROKERBROKERBROK", secret: "brokerSecretValue", token: "brokerSessionToken" };
const AGENT = { id: "ASIAAGENTAGENTAGENTA", secret: "agentSecretValue", token: "agentSessionToken" };

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
let calls: { action: string; params: URLSearchParams; signer: string }[];
let stacks: Map<string, FakeStack>;
let roles: Map<string, FakeRole>;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL_CLOUDFORMATION", "AWS_ENDPOINT_URL_IAM", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "SIKRETS_STACK_TEMPLATE_URL"];

const esc = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const ok = (ns: string, action: string, body: string) =>
  new Response(`<${action}Response xmlns="${ns}"><${action}Result>${body}</${action}Result><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata></${action}Response>`, { headers: { "content-type": "text/xml" } });
const fail = (status: number, code: string, message: string) =>
  new Response(`<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${esc(message)}</Message></Error><RequestId>1</RequestId></ErrorResponse>`, { status, headers: { "content-type": "text/xml" } });
const members = (p: URLSearchParams, prefix: string) => {
  const items: Record<string, string>[] = [];
  for (const [k, v] of p) {
    const m = new RegExp(`^${prefix.replaceAll(".", "\\.")}\\.member\\.(\\d+)(?:\\.(.+))?$`).exec(k);
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

const creds = (c: { id: string; secret: string; token: string }, seconds: number) =>
  `<Credentials><AccessKeyId>${c.id}</AccessKeyId><SecretAccessKey>${c.secret}</SecretAccessKey><SessionToken>${c.token}</SessionToken><Expiration>${new Date(Date.now() + seconds * 1000).toISOString()}</Expiration></Credentials>`;

const stackXml = (s: FakeStack) => {
  const outputs =
    s.status === "CREATE_COMPLETE" || s.status === "UPDATE_COMPLETE"
      ? {
          [AWS_STACK.outputs.brokerRole]: BROKER_ARN,
          [AWS_STACK.outputs.key]: KEY_ARN,
          [AWS_STACK.outputs.boundary]: BOUNDARY_ARN,
          [AWS_STACK.outputs.agentRolePath]: s.params[AWS_STACK.params.agentRolePath]!,
          [AWS_STACK.outputs.auditLogGroup]: `/aws/events/${s.name}-agents`,
        }
      : {};
  return `<member><StackName>${s.name}</StackName><StackId>${s.id}</StackId><StackStatus>${s.status}</StackStatus><CreationTime>2026-11-01T00:00:00Z</CreationTime>
<Parameters>${Object.entries(s.params).map(([k, v]) => `<member><ParameterKey>${k}</ParameterKey><ParameterValue>${esc(v)}</ParameterValue></member>`).join("")}</Parameters>
<Outputs>${Object.entries(outputs).map(([k, v]) => `<member><OutputKey>${k}</OutputKey><OutputValue>${esc(v)}</OutputValue></member>`).join("")}</Outputs></member>`;
};

const roleXml = (r: FakeRole) =>
  `<Path>${r.path}</Path><RoleName>${r.name}</RoleName><RoleId>AROA${r.name.length}</RoleId><Arn>${r.arn}</Arn><CreateDate>2026-11-01T00:00:00Z</CreateDate><AssumeRolePolicyDocument>${esc(encodeURIComponent(r.trust))}</AssumeRolePolicyDocument>` +
  (r.boundary ? `<PermissionsBoundary><PermissionsBoundaryType>Policy</PermissionsBoundaryType><PermissionsBoundaryArn>${r.boundary}</PermissionsBoundaryArn></PermissionsBoundary>` : "") +
  `<Tags>${Object.entries(r.tags).map(([k, v]) => `<member><Key>${k}</Key><Value>${esc(v)}</Value></member>`).join("")}</Tags>`;

function findStack(nameOrId: string) {
  for (const s of stacks.values()) if (s.name === nameOrId || s.id === nameOrId) return s;
  return undefined;
}

function aws(action: string, p: URLSearchParams, signer: string): Response {
  switch (action) {
    // ── STS
    case "GetCallerIdentity":
      return ok(STS, action, `<Arn>arn:aws:iam::${ACCOUNT}:user/dev</Arn><UserId>AIDA</UserId><Account>${ACCOUNT}</Account>`);
    case "AssumeRole": {
      const arn = p.get("RoleArn")!;
      const seconds = Number(p.get("DurationSeconds"));
      if (arn === BROKER_ARN) {
        const s = findStack(STACK);
        if (!s || p.get("ExternalId") !== s.params[AWS_STACK.params.externalId]) return fail(403, "AccessDenied", "external ID mismatch");
        return ok(STS, action, creds(BROKER, seconds) + `<AssumedRoleUser><Arn>${arn}/${p.get("RoleSessionName")}</Arn><AssumedRoleId>AROA:b</AssumedRoleId></AssumedRoleUser>`);
      }
      const role = [...roles.values()].find((r) => r.arn === arn);
      if (!role || signer !== BROKER.id) return fail(403, "AccessDenied", "not trusted");
      return ok(STS, action, creds(AGENT, seconds) + `<AssumedRoleUser><Arn>${arn}/${p.get("RoleSessionName")}</Arn><AssumedRoleId>AROA:a</AssumedRoleId></AssumedRoleUser>`);
    }
    // ── CloudFormation
    case "DescribeStacks": {
      const s = findStack(p.get("StackName")!);
      if (!s || (s.status === "DELETE_COMPLETE" && s.name === p.get("StackName"))) return fail(400, "ValidationError", `Stack with id ${p.get("StackName")} does not exist`);
      if (s.status.endsWith("_IN_PROGRESS")) {
        if (s.describesUntilDone-- <= 0) s.status = s.failOnCreate ? "ROLLBACK_COMPLETE" : s.status.replace("_IN_PROGRESS", "_COMPLETE");
      }
      return ok(CFN, action, `<Stacks>${stackXml(s)}</Stacks>`);
    }
    case "CreateStack":
    case "UpdateStack": {
      const name = p.get("StackName")!;
      const params = Object.fromEntries(members(p, "Parameters").map((m) => [m.ParameterKey!, m.ParameterValue!]));
      const existing = findStack(name);
      if (action === "UpdateStack") {
        if (!existing) return fail(400, "ValidationError", `Stack ${name} does not exist`);
        if (JSON.stringify(existing.params) === JSON.stringify(params) && existing.template === p.get("TemplateBody")) return fail(400, "ValidationError", "No updates are to be performed.");
      }
      const s: FakeStack = existing ?? {
        id: `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/uuid-1`,
        name,
        status: "",
        params: {},
        template: "",
        capabilities: [],
        tags: {},
        describesUntilDone: 0,
      };
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
        if ([...roles.values()].some((r) => r.boundary === BOUNDARY_ARN)) s.status = "DELETE_FAILED"; // the boundary is still attached
        else s.status = "DELETE_COMPLETE";
      }
      return ok(CFN, action, "");
    }
    case "DescribeStackEvents":
      return ok(CFN, action, `<StackEvents><member><StackId>x</StackId><EventId>1</EventId><StackName>${STACK}</StackName><Timestamp>2026-11-01T00:00:00Z</Timestamp><LogicalResourceId>VaultKey</LogicalResourceId><ResourceStatus>CREATE_FAILED</ResourceStatus><ResourceStatusReason>kms says no</ResourceStatusReason></member></StackEvents>`);
    // ── IAM (only the broker may call it, as in the template)
    default: {
      if (signer !== BROKER.id) return fail(403, "AccessDenied", `${signer} is not the broker`);
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
      if (action === "ListRolePolicies") return ok(IAM, action, `<PolicyNames>${Object.keys(role.policies).map((n) => `<member>${n}</member>`).join("")}</PolicyNames><IsTruncated>false</IsTruncated>`);
      if (action === "DeleteRolePolicy") {
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

beforeEach(async () => {
  keychain.clear();
  out = [];
  err = [];
  calls = [];
  stacks = new Map();
  roles = new Map();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-stack-home-"));
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-stack-"));
  process.env.SIKRETS_CONFIG_DIR = home;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const params = new URLSearchParams(await req.text());
      const signer = /Credential=([A-Z0-9]+)\//.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
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
    AWS_ACCESS_KEY_ID: USER.id,
    AWS_SECRET_ACCESS_KEY: USER.secret,
    AWS_REGION: REGION,
    AWS_CONFIG_FILE: path.join(home, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, "no-aws-credentials"),
  });
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.SIKRETS_STACK_TEMPLATE_URL;
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

const aws_ = async () => (await import("./commands/aws.ts")).run;
const agent = async () => (await import("./commands/agent.ts")).run;
const printed = () => [...out, ...err].join("\n");
const externalIdInKeychain = () => keychain.get(`dev.sikrets.aws/${AWS_STACK.externalIdAccount(REGION, STACK)}`);
const stateFile = () => path.join(home, AWS_STACK.stateFile);
const actions = () => calls.map((c) => c.action);
const notTTY = () => Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
const connect = async (opts: Record<string, unknown> = {}) => (await aws_())(["connect"], { region: REGION, ...opts });

describe("aws connect", () => {
  test("creates the stack with your credentials, an external ID from the keychain, and records the outputs", async () => {
    await connect();
    const [s] = [...stacks.values()];
    expect(s!.status).toBe("CREATE_COMPLETE");
    expect(s!.template).toBe(await Bun.file(path.join(import.meta.dir, "../../stack/sikrets.yaml")).text());
    expect(s!.capabilities).toEqual(["CAPABILITY_IAM"]);
    expect(s!.tags).toEqual({ [AWS_STACK.managedByTag]: "sikrets" });
    const ext = externalIdInKeychain()!;
    expect(ext.length).toBeGreaterThanOrEqual(16);
    expect(s!.params).toEqual({ TrustedAccountId: ACCOUNT, ExternalId: ext, AgentRolePath: AGENT_ROLE.path });
    expect(calls.find((c) => c.action === "CreateStack")!.signer).toBe(USER.id);

    const state = await Bun.file(stateFile()).json();
    expect(state).toMatchObject({ stackName: STACK, region: REGION, account: ACCOUNT, trustedAccount: ACCOUNT, brokerRoleArn: BROKER_ARN, keyArn: KEY_ARN, boundaryArn: BOUNDARY_ARN, agentRolePath: AGENT_ROLE.path });
    expect((await stat(stateFile())).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(state)).not.toContain(ext);
    expect(printed()).not.toContain(ext);
    expect(err.join("\n")).toContain(BROKER_ARN);
  });

  test("re-running is a no-op that keeps the external ID; --trust-account updates the trust", async () => {
    await connect();
    const ext = externalIdInKeychain();
    calls = [];
    await connect({ json: true });
    expect(actions()).toContain("UpdateStack");
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ action: "unchanged", brokerRoleArn: BROKER_ARN });
    expect(externalIdInKeychain()).toBe(ext);

    await connect({ "trust-account": "999988887777", json: true });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ action: "updated", trustedAccount: "999988887777" });
    expect([...stacks.values()][0]!.params.TrustedAccountId).toBe("999988887777");
    await expect(connect({ "trust-account": "12" })).rejects.toThrow("12-digit");
  });

  test("waits while CloudFormation works, and reports why a failed stack failed", async () => {
    const { deployStack } = await import("./core/aws-stack.ts");
    const log: string[] = [];
    const original = aws;
    // Two in-progress polls before completion.
    server.reload({
      async fetch(req) {
        const params = new URLSearchParams(await req.text());
        const action = params.get("Action")!;
        const res = original(action, params, USER.id);
        if (action === "CreateStack") [...stacks.values()][0]!.describesUntilDone = 2;
        return res;
      },
    });
    const s = await deployStack({ region: REGION, stackName: STACK, log: (m) => log.push(m), pollMs: 1 });
    expect(s.action).toBe("created");
    expect(log.filter((l) => l.includes("CREATE_IN_PROGRESS"))).toHaveLength(1);
    expect(log.at(-1)).toContain("CREATE_COMPLETE");

    stacks.clear();
    server.reload({
      async fetch(req) {
        const params = new URLSearchParams(await req.text());
        const action = params.get("Action")!;
        const res = original(action, params, USER.id);
        if (action === "CreateStack") [...stacks.values()][0]!.failOnCreate = true;
        return res;
      },
    });
    await expect(deployStack({ region: REGION, stackName: STACK, log: () => {}, pollMs: 1 })).rejects.toThrow("ROLLBACK_COMPLETE: VaultKey: kms says no");
    await expect(deployStack({ region: REGION, stackName: STACK, log: () => {}, pollMs: 1 })).rejects.toThrow("sikrets aws disconnect");
  });

  test("--link prints a quick-create URL and deploys nothing", async () => {
    await expect(connect({ link: true })).rejects.toThrow("--template-url");
    await connect({ link: true, "template-url": "https://bucket.s3.amazonaws.com/sikrets.yaml", "trust-account": "999988887777" });
    const url = new URL(out[0]!.replace("#/stacks/quickcreate", "")); // the console puts the query after a hash route
    expect(out[0]).toStartWith(`https://console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks/quickcreate?`);
    const q = new URLSearchParams(out[0]!.split("quickcreate?")[1]);
    expect(url.hostname).toBe("console.aws.amazon.com");
    expect(q.get("templateURL")).toBe("https://bucket.s3.amazonaws.com/sikrets.yaml");
    expect(q.get("stackName")).toBe(STACK);
    expect(q.get("param_TrustedAccountId")).toBe("999988887777");
    expect(q.get("param_ExternalId")).toBe(externalIdInKeychain()!);
    expect(q.get("param_AgentRolePath")).toBe(AGENT_ROLE.path);
    expect(actions()).not.toContain("CreateStack");
  });
});

describe("agent role", () => {
  beforeEach(() => connect());

  test("creates the role as the broker, under the boundary, tagged, and hands the command only temporary credentials", async () => {
    calls = [];
    const file = path.join(root, "creds.txt");
    const run = await agent();
    await run(["role", "reporter", "sh", "-c", `printf %s "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY:$AWS_SESSION_TOKEN" > ${file}`], {
      allow: ["s3:GetObject,s3:ListBucket=arn:aws:s3:::reports/*", "s3:ListAllMyBuckets", "s3:PutObject=arn:aws:s3:::reports/*"],
      ttl: "30m",
    });

    // You assume the broker with the external ID; IAM and the agent's AssumeRole are signed as the broker.
    const broker = calls.find((c) => c.action === "AssumeRole")!;
    expect(broker.signer).toBe(USER.id);
    expect(broker.params.get("RoleArn")).toBe(BROKER_ARN);
    expect(broker.params.get("ExternalId")).toBe(externalIdInKeychain()!);
    expect(calls.filter((c) => !["AssumeRole"].includes(c.action)).every((c) => c.signer === BROKER.id)).toBe(true);

    const role = roles.get("sikrets-agent-reporter")!;
    expect(role.path).toBe(AGENT_ROLE.path);
    expect(role.boundary).toBe(BOUNDARY_ARN);
    expect(role.tags).toEqual({ [AGENT_ROLE.tag]: "reporter", [AWS_STACK.managedByTag]: "sikrets" });
    expect(JSON.parse(role.trust).Statement[0].Principal).toEqual({ AWS: BROKER_ARN });
    expect(JSON.parse(role.policies[AGENT_ROLE.policyName]!).Statement).toEqual([
      { Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"], Resource: "arn:aws:s3:::reports/*" },
      { Effect: "Allow", Action: ["s3:ListAllMyBuckets"], Resource: "*" },
    ]);

    const assume = calls.filter((c) => c.action === "AssumeRole")[1]!;
    expect(assume.params.get("RoleArn")).toBe(role.arn);
    expect(assume.params.get("DurationSeconds")).toBe("1800");
    expect(assume.params.get("RoleSessionName")).toBe("sikrets-reporter");
    expect(await Bun.file(file).text()).toBe(`${AGENT.id}:${AGENT.secret}:${AGENT.token}`);
    for (const secret of [AGENT.secret, AGENT.token, BROKER.secret, BROKER.token, USER.secret, externalIdInKeychain()!]) expect(printed()).not.toContain(secret);
  });

  test("an existing role is reused without --allow, and credentials default to 15 minutes", async () => {
    notTTY();
    const run = await agent();
    await run(["role", "reporter", "true"], { allow: ["s3:GetObject=arn:aws:s3:::reports/*"] });
    calls = [];
    await run(["role", "reporter"], { env: true });
    expect(actions()).toEqual(["AssumeRole", "GetRole", "AssumeRole"]);
    expect(calls[2]!.params.get("DurationSeconds")).toBe(String(15 * 60));
    expect(out.at(-1)).toContain(`export AWS_ACCESS_KEY_ID='${AGENT.id}'`);
    expect(out.at(-1)).not.toContain(BROKER.id);
  });

  test("refuses before calling AWS: no stack, bad --allow, out-of-range --ttl, nowhere to deliver", async () => {
    const run = await agent();
    calls = [];
    await expect(run(["role", "reporter", "true"], { allow: ["iam:PassRole"] })).rejects.toThrow("permissions boundary denies it");
    await expect(run(["role", "reporter", "true"], { allow: ["s3:GetObject=bucket"] })).rejects.toThrow("must be an ARN");
    await expect(run(["role", "reporter", "true"], { allow: ["GetObject"] })).rejects.toThrow("isn't an IAM action");
    await expect(run(["role", "reporter", "true"], { allow: ["s3:GetObject"], ttl: "2h" })).rejects.toThrow("15m to 60m");
    await expect(run(["role", "reporter"], { allow: ["s3:GetObject"] })).rejects.toThrow("Say where the credentials go");
    await expect(run(["role", "Bad_Name", "true"], {})).rejects.toThrow("Invalid agent name");
    expect(calls).toHaveLength(0);
    await expect(run(["role", "reporter", "true"], {})).rejects.toThrow("has no role yet");
    expect(roles.size).toBe(0);

    await (await import("./core/fs.ts")).remove(stateFile());
    await expect(run(["role", "reporter", "true"], { allow: ["s3:GetObject"] })).rejects.toThrow("sikrets aws connect");
  });

  test("won't touch a same-named role that isn't a Sikrets agent role", async () => {
    roles.set("sikrets-agent-reporter", { name: "sikrets-agent-reporter", path: AGENT_ROLE.path, arn: `arn:aws:iam::${ACCOUNT}:role/x`, tags: {}, trust: "{}", policies: {} });
    await expect((await agent())(["role", "reporter", "true"], { allow: ["s3:GetObject"] })).rejects.toThrow("refusing to touch it");
    expect(actions()).not.toContain("PutRolePolicy");
  });

  test("--revoke deletes the role and its policy", async () => {
    const run = await agent();
    await run(["role", "reporter", "true"], { allow: ["s3:GetObject"] });
    await run(["role", "reporter"], { revoke: true });
    expect(roles.size).toBe(0);
    expect(actions().slice(-3)).toEqual(["ListRolePolicies", "DeleteRolePolicy", "DeleteRole"]);
  });

  test("a wrong external ID gets nothing", async () => {
    keychain.set(`dev.sikrets.aws/${AWS_STACK.externalIdAccount(REGION, STACK)}`, "not-the-external-id");
    await expect((await agent())(["role", "reporter", "true"], { allow: ["s3:GetObject"] })).rejects.toThrow("external ID mismatch");
    expect(roles.size).toBe(0);
  });
});

describe("aws disconnect", () => {
  test("deletes every agent role, then the stack, and forgets it", async () => {
    await connect();
    const run = await agent();
    await run(["role", "reporter", "true"], { allow: ["s3:GetObject"] });
    await run(["role", "builder", "true"], { allow: ["ecr:GetAuthorizationToken"] });

    await expect((await aws_())(["disconnect"], {})).rejects.toThrow("--yes");
    expect(roles.size).toBe(2);

    await (await aws_())(["disconnect"], { yes: true, json: true });
    expect(roles.size).toBe(0);
    expect([...stacks.values()][0]!.status).toBe("DELETE_COMPLETE");
    expect(JSON.parse(out.at(-1)!)).toEqual({ deleted: STACK, agentRoles: ["sikrets-agent-reporter", "sikrets-agent-builder"] });
    expect(actions().indexOf("DeleteStack")).toBeGreaterThan(actions().lastIndexOf("DeleteRole"));
    expect(calls.find((c) => c.action === "DeleteStack")!.signer).toBe(USER.id);
    expect(await Bun.file(stateFile()).exists()).toBe(false);
    expect(externalIdInKeychain()).toBeUndefined();
    await expect((await aws_())(["disconnect"], { yes: true })).rejects.toThrow("nothing to disconnect");
  });
});

describe("stack template", () => {
  const text = () => Bun.file(path.join(import.meta.dir, "../../stack/sikrets.yaml")).text();
  // Bun's YAML parser drops CloudFormation's short tags (!Ref X parses as "X"), which is enough to
  // check structure; references are checked on the text below.
  const parsed = async () => Bun.YAML.parse(await text()) as Record<string, Record<string, any>>;

  test("parses, and every resource has a type", async () => {
    const t = await parsed();
    expect(t.AWSTemplateFormatVersion as unknown).toBe("2010-09-09");
    const types = Object.fromEntries(Object.entries(t.Resources!).map(([k, v]) => [k, v.Type]));
    expect(types).toMatchObject({
      BrokerRole: "AWS::IAM::Role",
      BrokerPolicy: "AWS::IAM::Policy",
      VaultKey: "AWS::KMS::Key",
      AgentBoundary: "AWS::IAM::ManagedPolicy",
      AuditLogGroup: "AWS::Logs::LogGroup",
      AgentActivityRule: "AWS::Events::Rule",
      Trail: "AWS::CloudTrail::Trail",
    });
    // No EC2 or enclave infrastructure in this stack.
    expect(Object.values(types).some((x) => String(x).startsWith("AWS::EC2::"))).toBe(false);
  });

  test("every Ref, GetAtt and ${} names a parameter, resource or pseudo parameter", async () => {
    const t = await parsed();
    const known = new Set([...Object.keys(t.Parameters!), ...Object.keys(t.Resources!), "AWS::AccountId", "AWS::Region", "AWS::Partition", "AWS::StackName", "AWS::StackId", "AWS::NoValue"]);
    const body = await text();
    const refs = [
      ...[...body.matchAll(/!Ref\s+([\w:]+)/g)].map((m) => m[1]!),
      ...[...body.matchAll(/!GetAtt\s+(\w+)\./g)].map((m) => m[1]!),
      ...[...body.matchAll(/\$\{([\w:]+)(?:\.\w+)?\}/g)].map((m) => m[1]!),
    ];
    expect(refs.length).toBeGreaterThan(20);
    expect(refs.filter((r) => !known.has(r))).toEqual([]);
    const conditions = new Set(Object.keys(t.Conditions!));
    for (const r of Object.values(t.Resources!)) if (r.Condition) expect(conditions.has(r.Condition)).toBe(true);
  });

  test("matches what the CLI passes and reads", async () => {
    const t = await parsed();
    for (const p of Object.values(AWS_STACK.params)) expect(t.Parameters![p]).toBeDefined();
    for (const o of Object.values(AWS_STACK.outputs)) expect(t.Outputs![o]).toBeDefined();
    expect(t.Parameters!.AgentRolePath!.Default).toBe(AGENT_ROLE.path);
    expect(t.Parameters!.ExternalId!.NoEcho).toBe(true);
  });

  test("the broker needs the external ID, agent roles need the boundary, and the account can't decrypt", async () => {
    const t = await parsed();
    const trust = t.Resources!.BrokerRole!.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Condition.StringEquals["sts:ExternalId"]).toBeDefined();
    const broker = t.Resources!.BrokerPolicy!.Properties.PolicyDocument.Statement as any[];
    const create = broker.find((s) => s.Action === "iam:CreateRole");
    expect(Object.keys(create.Condition.StringEquals)).toEqual(["iam:PermissionsBoundary"]);
    expect(create.Condition.Null[`aws:RequestTag/${AGENT_ROLE.tag}`]).toBe("false");
    expect(broker.find((s) => s.Effect === "Deny").Action).toContain("iam:DeleteRolePermissionsBoundary");
    const keyPolicy = t.Resources!.VaultKey!.Properties.KeyPolicy.Statement as any[];
    expect(keyPolicy.find((s) => s.Sid === "AccountManagesButCannotDecrypt").Action).not.toContain("kms:Decrypt");
    const boundary = t.Resources!.AgentBoundary!.Properties.PolicyDocument.Statement as any[];
    const denied = boundary.filter((s) => s.Effect === "Deny").flatMap((s) => [s.Action].flat());
    for (const service of AGENT_ROLE.deniedServices) expect(denied.some((a: string) => a.startsWith(`${service}:`))).toBe(true);
  });
});
