import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Secret } from "./core/secret.ts";
import { state, type Resource } from "./core/state.ts";
import { openVault } from "./core/vault.ts";
import { native } from "./core/doorman.ts";

// Vault values are stored sealed, so read them back the way the CLI does rather than off the raw keychain entry.
const opened = async (project: string, key: string) => (await (await openVault(project, "keychain")).get(key))?.reveal();

// Credential hygiene: usage log, inventory, agent identities, offboarding and short-lived
// credentials. Providers are faked (fetch is mocked; STS is a local HTTP server), the keychain is
// in memory, and the project and user dir are throwaway folders.

const keychain = new Map<string, string>();
let root: string;
let home: string;
let cwd: string;
let fetched: { url: URL; init?: RequestInit }[];
let handler: (url: URL, init?: RequestInit) => Response | undefined;
let out: string[];
let err: string[];

// Fake keys, assembled at runtime so secret scanners don't mistake the test for a leak.
const fake = (prefix: string, body: string) => [prefix, body].join("_");
const GITHUB_PAT = fake("ghp", "abcdefghijklmnopqrstuvwxyz0123456789");
const STRIPE_SECRET = fake("sk_live", "fakefakefakefakefakefakefake");
const STRIPE_RESTRICTED = fake("rk_live", "fakefakefakefakefakefakefake");
const AWS_KEY = `AKIAABCDEFGHIJKLMNOP:${"s".repeat(36)}abcd`;

beforeEach(async () => {
  keychain.clear();
  fetched = [];
  out = [];
  err = [];
  handler = () => undefined;
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-hygiene-"));
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-home-"));
  process.env.SIKRETS_CONFIG_DIR = home;
  process.env.SIKRETS_VAULT = "keychain";
  delete process.env.SIKRETS_AGENT;
  await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo", vault: "keychain" }));
  cwd = process.cwd();
  process.chdir(root);

  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    fetched.push({ url, init });
    return handler(url, init) ?? new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch);
  spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(async () => {
  mock.restore();
  process.chdir(cwd);
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

/** A live resource in state with its secret in the (fake) keychain vault. */
async function stored(name: string, recipe: Resource["recipe"], value: string, over: Partial<Resource> = {}) {
  const env = recipe === "github/app-key" ? "PRIVATE_KEY" : recipe === "aws/access-key" ? "ACCESS_KEY" : "API_KEY";
  const key = `${name.toUpperCase().replaceAll("-", "_")}_${env}`;
  const res: Resource = { name, recipe, provider: recipe.split("/")[0]!, strategy: "manual", inputs: {}, dependsOn: {}, envKeys: [key], outputs: {}, applied: true, createdAt: new Date().toISOString(), ...over };
  await state.upsert(root, res);
  await (await openVault("demo", "keychain")).put(key, Secret.of(value));
  return key;
}

const command = async (name: string) => (await import(`./commands/${name}.ts`)) as { run: (args: string[], opts: Record<string, unknown>) => Promise<void> };
const usageFile = () => path.join(home, "usage", "demo.jsonl");
const readUses = async () => (await import("./core/usage.ts")).readUsage("demo");
/** Everything a command printed, to check no secret ever reaches a terminal or transcript. */
const printed = () => [...out, ...err].join("\n");
const notTTY = () => Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

describe("usage log", () => {
  test("run records key names per app, owner-only, outside the project, never values", async () => {
    const key = await stored("anthropic", "anthropic/api-key", "sk-ant-api03-secretsecretsecret");
    await (await command("run")).run(["true"], {});
    const uses = await readUses();
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ key, via: "run", app: "true", user: os.userInfo().username });
    expect(uses[0]!.agent).toBeUndefined();
    const text = await Bun.file(usageFile()).text();
    expect(text).not.toContain("secretsecret");
    expect((await stat(usageFile())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(usageFile()))).mode & 0o777).toBe(0o700);
    expect(await Bun.file(path.join(root, ".sikrets/usage.jsonl")).exists()).toBe(false);
  });

  test("env pull records only real hand-outs, not stand-ins", async () => {
    await stored("anthropic", "anthropic/api-key", "sk-ant-api03-secretsecretsecret");
    const env = await command("env");
    await env.run(["pull"], {});
    expect(await readUses()).toHaveLength(0);
    spyOn(native, "authenticate").mockImplementation(async () => ({ ok: true }));
    await env.run(["pull"], { real: true });
    expect((await readUses()).map((u) => [u.key, u.via, u.app])).toEqual([["ANTHROPIC_API_KEY", "env.pull", ".env"]]);
  });
});

describe("inventory", () => {
  test("ages, last use, apps and agents per key", async () => {
    await stored("anthropic", "anthropic/api-key", "sk-ant-api03-secretsecretsecret", { createdAt: daysAgo(10), lastRotatedAt: daysAgo(2) });
    const { recordUse } = await import("./core/usage.ts");
    await recordUse("demo", { keys: ["ANTHROPIC_API_KEY"], via: "run", app: "bun" });
    await recordUse("demo", { keys: ["ANTHROPIC_API_KEY"], via: "run", app: "claude", agent: "reviewer" });
    const { inventory } = await import("./commands/inventory.ts");
    const [row] = await inventory(root);
    expect(row).toMatchObject({ key: "ANTHROPIC_API_KEY", resource: "anthropic", apps: ["bun", "claude"], agents: ["reviewer"], stale: false, scope: null });
    expect(row!.lastUsed).toBeString();
    expect(fetched).toHaveLength(0);
  });

  test("stale means older than 90 days and unused for 30", async () => {
    const { isStale } = await import("./commands/inventory.ts");
    expect(isStale({ createdAt: daysAgo(100) }, undefined)).toBe(true);
    expect(isStale({ createdAt: daysAgo(100) }, daysAgo(40))).toBe(true);
    expect(isStale({ createdAt: daysAgo(100) }, daysAgo(5))).toBe(false); // in use
    expect(isStale({ createdAt: daysAgo(100), lastRotatedAt: daysAgo(10) }, undefined)).toBe(false); // value is new
    expect(isStale({ createdAt: daysAgo(60) }, undefined)).toBe(false);
  });

  test("flags Stripe secret keys by prefix and broad GitHub scopes from X-OAuth-Scopes", async () => {
    await stored("stripe", "anthropic/api-key", STRIPE_SECRET);
    await stored("stripe-ro", "anthropic/api-key", STRIPE_RESTRICTED);
    await stored("gh", "anthropic/api-key", GITHUB_PAT, { createdAt: daysAgo(200) });
    handler = (url, init) => {
      if (url.hostname === "api.github.com" && url.pathname === "/user") {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${GITHUB_PAT}`);
        return new Response("{}", { headers: { "X-OAuth-Scopes": "repo, read:org, admin:org" } });
      }
    };
    const { inventory, run } = await import("./commands/inventory.ts");
    const rows = Object.fromEntries((await inventory(root)).map((r) => [r.resource, r]));
    expect(rows.stripe!.scope).toMatchObject({ provider: "stripe", overScoped: true });
    expect(rows["stripe-ro"]!.scope).toMatchObject({ provider: "stripe", overScoped: false });
    expect(rows.gh!.scope).toEqual({ provider: "github", overScoped: true, detail: "broad scopes: repo, admin:org" });
    expect(rows.gh!.stale).toBe(true);
    expect(fetched).toHaveLength(1);

    // --offline: no GitHub request; Stripe still checked by prefix. Output never shows values.
    fetched = [];
    await run([], { offline: true });
    expect(fetched).toHaveLength(0);
    const text = printed();
    expect(text).toContain("over-scoped (stripe)");
    expect(text).toContain("stale");
    for (const v of [GITHUB_PAT, STRIPE_SECRET, STRIPE_RESTRICTED]) expect(text).not.toContain(v);
  });

  test("narrow GitHub tokens and fine-grained ones aren't flagged", async () => {
    await stored("gh", "anthropic/api-key", GITHUB_PAT);
    await stored("fine", "anthropic/api-key", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop");
    handler = (url) => (url.pathname === "/user" ? new Response("{}", { headers: { "X-OAuth-Scopes": "read:org, public_repo" } }) : undefined);
    const { inventory } = await import("./commands/inventory.ts");
    const rows = Object.fromEntries((await inventory(root)).map((r) => [r.resource, r]));
    expect(rows.gh!.scope).toMatchObject({ overScoped: false, detail: "scopes: read:org, public_repo" });
    expect(rows.fine!.scope).toBeNull();
  });
});

describe("agent identities", () => {
  test("an agent is handed only its scope; revoking it cuts off only that agent", async () => {
    await stored("anthropic", "anthropic/api-key", "sk-ant-api03-secretsecretsecret");
    await stored("stripe", "anthropic/api-key", STRIPE_RESTRICTED);
    const agent = await command("agent");
    const run = await command("run");
    await agent.run(["add", "reviewer"], { key: ["anthropic"] });
    await agent.run(["add", "billing"], { key: ["STRIPE_API_KEY"], expires: "7d" });

    // The child sees only the agent's keys.
    const dump = path.join(root, "env.txt");
    await run.run(["sh", "-c", `env > ${dump}`], { agent: "reviewer" });
    const env = await Bun.file(dump).text();
    expect(env).toContain("ANTHROPIC_API_KEY=");
    expect(env).not.toContain("STRIPE_API_KEY=");
    expect((await readUses()).at(-1)).toMatchObject({ key: "ANTHROPIC_API_KEY", agent: "reviewer", app: "sh" });

    await agent.run(["revoke", "reviewer"], {});
    await expect(run.run(["true"], { agent: "reviewer" })).rejects.toThrow('Agent "reviewer" was revoked');
    process.env.SIKRETS_AGENT = "billing"; // same check via the environment
    await run.run(["true"], {});
    expect((await readUses()).at(-1)).toMatchObject({ key: "STRIPE_API_KEY", agent: "billing" });
    await expect(run.run(["true"], { providers: true })).rejects.toThrow("provider admin credentials");

    out = [];
    await agent.run(["list"], { json: true });
    const listed = JSON.parse(out[0]!) as { name: string; status: string; expiresAt?: string }[];
    expect(listed.map((a) => [a.name, a.status])).toEqual([["reviewer", "revoked"], ["billing", "active"]]);
    expect(Date.parse(listed[1]!.expiresAt!) - Date.now()).toBeGreaterThan(6 * DAY);
  });

  test("unknown, expired and out-of-scope agents get nothing", async () => {
    await stored("anthropic", "anthropic/api-key", "sk-ant-api03-secretsecretsecret");
    const { agents, authorize } = await import("./core/agents.ts");
    await expect(authorize(root, "ghost", [{ key: "ANTHROPIC_API_KEY" }])).rejects.toThrow('No agent named "ghost"');
    await agents.save(root, [
      { name: "old", scope: ["anthropic"], createdAt: daysAgo(10), expiresAt: daysAgo(1) },
      { name: "other", scope: ["stripe"], createdAt: daysAgo(1) },
    ]);
    await expect(authorize(root, "old", [{ key: "ANTHROPIC_API_KEY", resource: "anthropic" }])).rejects.toThrow("expired");
    await expect(authorize(root, "other", [{ key: "ANTHROPIC_API_KEY", resource: "anthropic" }])).rejects.toThrow("may not use anthropic");
    const agent = await command("agent");
    await expect(agent.run(["add", "x"], { key: ["nope"] })).rejects.toThrow("Not in this project: nope");
    await expect(agent.run(["add", "Bad Name"], { key: ["anthropic"] })).rejects.toThrow("Invalid agent name");
  });
});

describe("offboard", () => {
  // Upstash's API, enough for `sikrets rotate` on a redis database.
  let token: string;
  const upstash = (url: URL, init?: RequestInit) => {
    if (init?.method === "POST" && url.pathname === "/v2/redis/reset-password/db_cache") {
      token = "tok_rotated_value";
      return Response.json({ database_id: "db_cache", database_name: "cache", endpoint: "happy-fox-123", rest_token: token });
    }
  };
  beforeEach(async () => {
    token = "tok_live_secret_value";
    process.env.UPSTASH_EMAIL = "dev@example.com";
    process.env.UPSTASH_API_KEY = "test-management-key";
    await stored("cache", "upstash/redis", token, { strategy: "api", remoteId: "db_cache", envKeys: ["CACHE_REDIS_REST_URL", "CACHE_REDIS_REST_TOKEN"] });
    await (await openVault("demo", "keychain")).put("CACHE_REDIS_REST_TOKEN", Secret.of(token));
    await (await openVault("demo", "keychain")).put("CACHE_REDIS_REST_URL", Secret.of("https://happy-fox-123.upstash.io"));
    await stored("anthropic", "anthropic/api-key", "sk-ant-api03-secretsecretsecret");
    const { recordUse } = await import("./core/usage.ts");
    await recordUse("demo", { keys: ["CACHE_REDIS_REST_URL", "CACHE_REDIS_REST_TOKEN"], via: "run", app: "claude", agent: "reviewer" });
    await recordUse("demo", { keys: ["OLD_API_KEY"], via: "run", app: "claude", agent: "reviewer" });
    await recordUse("demo", { keys: ["ANTHROPIC_API_KEY"], via: "run", app: "bun" }); // a person, not the agent
    const { agents } = await import("./core/agents.ts");
    await agents.save(root, [{ name: "reviewer", scope: ["cache"], createdAt: daysAgo(3) }]);
    handler = upstash;
  });

  test("--dry-run lists what the agent touched and changes nothing", async () => {
    await (await command("offboard")).run(["reviewer"], { "dry-run": true, json: true });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ dryRun: true, agent: true, rotate: ["cache"], keys: ["CACHE_REDIS_REST_URL", "CACHE_REDIS_REST_TOKEN", "OLD_API_KEY"] });
    expect(fetched).toHaveLength(0);
    expect(await opened("demo", "CACHE_REDIS_REST_TOKEN")).toBe("tok_live_secret_value");
    const { agents } = await import("./core/agents.ts");
    expect((await agents.find(root, "reviewer"))!.revokedAt).toBeUndefined();
  });

  test("revokes the agent and rotates only its keys, through sikrets rotate", async () => {
    await (await command("offboard")).run(["reviewer"], { yes: true, json: true });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ rotated: ["cache"], failed: [] });
    expect(await opened("demo", "CACHE_REDIS_REST_TOKEN")).toBe("tok_rotated_value");
    expect(await opened("demo", "ANTHROPIC_API_KEY")).toBe("sk-ant-api03-secretsecretsecret"); // not the agent's
    const { agents } = await import("./core/agents.ts");
    expect((await agents.find(root, "reviewer"))!.revokedAt).toBeString();
    const { readActivity } = await import("./core/activity.ts");
    expect((await readActivity(root)).at(-1)).toMatchObject({ kind: "rotate", keys: ["CACHE_REDIS_REST_TOKEN"] });
    expect(printed()).not.toContain("tok_");
  });

  test("a person's keys come from their own uses; failures don't stop the rest", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await (await command("offboard")).run([os.userInfo().username], { yes: true, json: true });
    // anthropic/api-key is a dashboard key: rotating needs a terminal to paste into, so it fails here.
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ agent: false, keys: ["ANTHROPIC_API_KEY"], rotated: [], failed: [{ resource: "anthropic" }] });
    expect(process.exitCode).toBe(1);
    await expect((await command("offboard")).run(["nobody"], {})).rejects.toThrow('Nothing recorded for "nobody"');
  });
});

describe("github token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const MINTED = "ghs_mintedinstallationtoken0123456789";

  beforeEach(async () => {
    await stored("github-app", "github/app-key", privateKey, { inputs: { app_id: "1234", installation_id: "42" } });
    handler = (url, init) => {
      if (init?.method !== "POST" || url.pathname !== "/app/installations/42/access_tokens") return undefined;
      const jwt = new Headers(init.headers).get("authorization")!.replace("Bearer ", "");
      const [h, p, s] = jwt.split(".");
      if (!createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))) return new Response("{}", { status: 401 });
      const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { iss: string; iat: number; exp: number };
      if (claims.iss !== "1234" || claims.exp - claims.iat > 600) return new Response("{}", { status: 401 });
      const body = JSON.parse(String(init.body)) as { repositories?: string[]; permissions?: Record<string, string> };
      return Response.json({ token: MINTED, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: body.permissions ?? { contents: "write" }, repository_selection: body.repositories ? "selected" : "all" }, { status: 201 });
    };
  });

  test("mints a narrowed one-hour token from a signed App JWT and exports it", async () => {
    notTTY();
    await (await command("github")).run(["token"], { env: true, repo: ["api"], permission: ["contents=read"] });
    expect(JSON.parse(String(fetched[0]!.init!.body))).toEqual({ repositories: ["api"], permissions: { contents: "read" } });
    expect(out).toEqual([`export GITHUB_TOKEN='${MINTED}'\nexport GH_TOKEN='${MINTED}'`]);
    expect(err.join("\n")).toMatch(/expires in (60m|1h)/);
    expect(err.join("\n")).not.toContain(MINTED);
    expect(await readUses()).toMatchObject([{ key: "GITHUB_APP_PRIVATE_KEY", via: "github.token", app: "env export" }]);
  });

  test("runs a command with the token, and never prints it to a terminal", async () => {
    const file = path.join(root, "tok.txt");
    await (await command("github")).run(["token", "sh", "-c", `printf %s "$GH_TOKEN" > ${file}`], {});
    expect(await Bun.file(file).text()).toBe(MINTED);
    expect(printed()).not.toContain(MINTED);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    await expect((await command("github")).run(["token"], { env: true })).rejects.toThrow("Refusing to print credentials to a terminal");
    notTTY();
    expect(fetched).toHaveLength(1); // the refusal happened before any token was minted
  });

  test("a wrong installation or app is explained; agents need the key in scope", async () => {
    notTTY();
    const github = await command("github");
    await expect(github.run(["token"], { env: true, installation: "7" })).rejects.toThrow("no installation 7 for app 1234");
    const { agents } = await import("./core/agents.ts");
    await agents.save(root, [{ name: "bot", scope: ["anthropic"], createdAt: daysAgo(1) }]);
    await expect(github.run(["token"], { env: true, agent: "bot" })).rejects.toThrow('Agent "bot" may not use github-app');
    expect(fetched).toHaveLength(1);
  });

  test("the recipe accepts only an RSA private key", async () => {
    const { recipe } = await import("./recipes/index.ts");
    const r = recipe("github/app-key");
    if (r.strategy !== "manual") throw new Error("expected a manual recipe");
    expect(r.pattern.test(privateKey.trim())).toBe(true);
    await r.verify(Secret.of(privateKey));
    await expect(r.verify(Secret.of("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----"))).rejects.toThrow("isn't a readable private key");
  });
});

describe("aws session", () => {
  // A local STS endpoint (the AWS SDK reaches it through AWS_ENDPOINT_URL_STS), so the real SDK
  // signs and sends real HTTP requests without touching AWS.
  let sts: ReturnType<typeof Bun.serve>;
  let calls: URLSearchParams[];
  let auth: string[];

  beforeEach(async () => {
    calls = [];
    auth = [];
    sts = Bun.serve({
      port: 0,
      async fetch(req) {
        const params = new URLSearchParams(await req.text());
        calls.push(params);
        auth.push(req.headers.get("authorization") ?? "");
        const action = params.get("Action")!;
        const expiry = new Date(Date.now() + Number(params.get("DurationSeconds")) * 1000).toISOString();
        const creds = `<Credentials><AccessKeyId>ASIATEMPORARYKEY0001</AccessKeyId><SecretAccessKey>tempSecretValue</SecretAccessKey><SessionToken>tempSessionToken</SessionToken><Expiration>${expiry}</Expiration></Credentials>`;
        const extra = action === "AssumeRole" ? `<AssumedRoleUser><Arn>${params.get("RoleArn")}/sikrets</Arn><AssumedRoleId>AROA:sikrets</AssumedRoleId></AssumedRoleUser>` : "";
        return new Response(`<${action}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${action}Result>${creds}${extra}</${action}Result><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata></${action}Response>`, { headers: { "content-type": "text/xml" } });
      },
    });
    process.env.AWS_ENDPOINT_URL_STS = `http://127.0.0.1:${sts.port}`;
    await stored("aws-key", "aws/access-key", AWS_KEY);
  });
  afterEach(() => {
    sts.stop(true);
    delete process.env.AWS_ENDPOINT_URL_STS;
  });

  test("GetSessionToken with the stored key, exported for a shell", async () => {
    notTTY();
    await (await command("aws")).run(["session"], { env: true, for: "15m" });
    expect(calls.map((c) => [c.get("Action"), c.get("DurationSeconds")])).toEqual([["GetSessionToken", "900"]]);
    expect(auth[0]).toContain("Credential=AKIAABCDEFGHIJKLMNOP/"); // signed with the stored key
    expect(out[0]).toContain("export AWS_ACCESS_KEY_ID='ASIATEMPORARYKEY0001'");
    expect(out[0]).toContain("export AWS_SESSION_TOKEN='tempSessionToken'");
    expect(out[0]).not.toContain("ssssssss"); // the long-lived secret is never handed out
    expect(err.join("\n")).not.toContain("tempSecretValue");
    expect(await readUses()).toMatchObject([{ key: "AWS_KEY_ACCESS_KEY", via: "aws.session", app: "env export" }]);
  });

  test("AssumeRole for a command, within 15–60 minutes", async () => {
    const file = path.join(root, "aws.txt");
    await (await command("aws")).run(["session", "sh", "-c", `printf %s "$AWS_SECRET_ACCESS_KEY" > ${file}`], { role: "arn:aws:iam::123456789012:role/deploy", for: "1h" });
    expect(calls[0]!.get("Action")).toBe("AssumeRole");
    expect(calls[0]!.get("RoleArn")).toBe("arn:aws:iam::123456789012:role/deploy");
    expect(calls[0]!.get("DurationSeconds")).toBe("3600");
    expect(await Bun.file(file).text()).toBe("tempSecretValue");
    expect(printed()).not.toContain("tempSecretValue");
    const { sessionSeconds } = await import("./core/aws-session.ts");
    expect(() => sessionSeconds("5m")).toThrow("15m to 60m");
    expect(() => sessionSeconds("2h")).toThrow("15m to 60m");
    expect(sessionSeconds("30m")).toBe(1800);
  });

  test("revoked agents get no session", async () => {
    notTTY();
    const agent = await command("agent");
    await agent.run(["add", "deployer"], { key: ["aws-key"] });
    await (await command("aws")).run(["session"], { env: true, agent: "deployer" });
    await agent.run(["revoke", "deployer"], {});
    await expect((await command("aws")).run(["session"], { env: true, agent: "deployer" })).rejects.toThrow("revoked");
    expect(calls).toHaveLength(1);
  });

  test("the recipe checks the key's shape before storing it", async () => {
    const { recipe } = await import("./recipes/index.ts");
    const r = recipe("aws/access-key");
    if (r.strategy !== "manual") throw new Error("expected a manual recipe");
    expect(r.pattern.test(AWS_KEY)).toBe(true);
    expect(r.pattern.test("AKIAABCDEFGHIJKLMNOP")).toBe(false);
  });
});
