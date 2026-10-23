import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planAdd, type AddRequest } from "./core/add.ts";
import { applyPlan, undoSteps, type Context } from "./core/plan.ts";
import { Secret } from "./core/secret.ts";
import { envValues, isStandIn } from "./core/standin.ts";
import { openVault } from "./core/vault.ts";
import { state } from "./core/state.ts";
import { recipe } from "./recipes/index.ts";
import { resolveInputs } from "./recipes/types.ts";
import "./core/files.ts";
import "./core/vault.ts";

// Fake Upstash account, in-memory keychain and a throwaway project, so nothing real is touched.
let databases: Record<string, { database_id: string; database_name: string; endpoint: string; rest_token: string }>;
let fetchCalls: number;
let failCreate: boolean;
const keychain = new Map<string, string>();
let root: string;
let ctx: Context;

beforeEach(async () => {
  databases = {};
  fetchCalls = 0;
  failCreate = false;
  keychain.clear();
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-test-"));
  ctx = { root, project: "demo", vault: "keychain", dryRun: false, log: () => {} };
  process.env.SIKRETS_VAULT = "keychain";
  process.env.UPSTASH_EMAIL = "dev@example.com";
  process.env.UPSTASH_API_KEY = "test-management-key";

  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls++;
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.hostname === "api.anthropic.com") {
      const key = new Headers(init?.headers).get("x-api-key");
      return key === GOOD_ANTHROPIC_KEY ? json({ data: [] }) : json({ error: { type: "authentication_error" } }, 401);
    }
    if (method === "GET" && url.pathname === "/v2/redis/databases") return json(Object.values(databases));
    if (method === "POST" && url.pathname === "/v2/redis/database") {
      if (failCreate) return json({ error: "boom" }, 500);
      const body = JSON.parse(String(init!.body)) as { database_name: string };
      const db = { database_id: `db_${body.database_name}`, database_name: body.database_name, endpoint: "happy-fox-123", rest_token: "tok_live_secret_value" };
      databases[db.database_id] = db;
      return json(db);
    }
    if (method === "DELETE" && url.pathname.startsWith("/v2/redis/database/")) {
      delete databases[url.pathname.split("/").pop()!];
      return new Response("", { status: 200 });
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const GOOD_ANTHROPIC_KEY = "sk-ant-api03-goodkeygoodkeygoodkey1234";
const exists = (rel: string) => Bun.file(path.join(root, rel)).exists();
const request = (over: Partial<AddRequest>): AddRequest => ({
  recipe: "upstash/redis",
  name: "cache",
  inputs: {},
  use: {},
  choose: async () => {
    throw new Error("unexpected prompt");
  },
  secret: async () => {
    throw new Error("unexpected secret prompt");
  },
  ...over,
});

describe("Secret", () => {
  test("never renders its value", () => {
    const s = Secret.of("sk_live_abcdefghijklmnop");
    expect(String(s)).not.toContain("sk_live");
    expect(`${s}`).not.toContain("sk_live");
    expect(JSON.stringify({ s })).not.toContain("sk_live");
    expect(Bun.inspect(s)).not.toContain("sk_live");
    expect(s.hint()).toEndWith("mnop");
    expect(s.reveal()).toBe("sk_live_abcdefghijklmnop");
  });
});

describe("inputs", () => {
  test("defaults fill in and bad values are rejected", () => {
    const r = recipe("aws/ec2");
    expect(resolveInputs(r, {})).toEqual({ size: "t4g.nano", disk: 8 });
    expect(() => resolveInputs(r, { size: "m5.24xlarge" })).toThrow("must be one of");
    expect(() => resolveInputs(r, { disk: "2" })).toThrow("from 8 to 200");
  });
});

describe("API recipes (upstash/redis)", () => {
  test("planning and dry runs make no API calls", async () => {
    const plan = await planAdd(request({ inputs: { plan: "payg", budget: "20" } }), { ...ctx, dryRun: true });
    expect(plan.changes.map((c) => c.summary)).toEqual([
      'Create upstash/redis "cache" at upstash',
      "Store CACHE_REDIS_REST_URL, CACHE_REDIS_REST_TOKEN in the vault",
      'Record "cache" in .sikrets/state.json',
      "Write CACHE_REDIS_REST_URL, CACHE_REDIS_REST_TOKEN (stand-in) to .env",
    ]);
    expect(plan.changes[0]!.cost).toBe("pay as you go, capped at $20/mo");
    expect(fetchCalls).toBe(0);
  });

  test("add stores outputs in the vault, rollback deletes everything", async () => {
    const plan = await planAdd(request({}), ctx);
    const op = await applyPlan("add upstash/redis", plan.changes, ctx);
    expect(Object.keys(databases)).toEqual(["db_cache"]);
    expect(keychain.get("dev.sikrets.vault.demo/CACHE_REDIS_REST_TOKEN")).toBe("tok_live_secret_value");
    const [res] = (await state.load(root)).resources;
    expect(res).toMatchObject({ name: "cache", remoteId: "db_cache", applied: true, outputs: { rest_url: "https://happy-fox-123.upstash.io" } });
    expect(JSON.stringify(res)).not.toContain("tok_live"); // the token is only in the vault

    await undoSteps(op, ctx);
    expect(Object.keys(databases)).toHaveLength(0);
    expect(keychain.size).toBe(0);
    expect((await state.load(root)).resources).toHaveLength(0);
  });

  test("a failure after creation deletes what was created", async () => {
    const plan = await planAdd(request({}), ctx);
    plan.changes[1]!.apply = async () => {
      throw new Error("vault unreachable");
    };
    await expect(applyPlan("add upstash/redis", plan.changes, ctx)).rejects.toThrow("vault unreachable");
    expect(Object.keys(databases)).toHaveLength(0);
  });

  test("a provider error leaves nothing behind", async () => {
    failCreate = true;
    await expect(applyPlan("add upstash/redis", (await planAdd(request({}), ctx)).changes, ctx)).rejects.toThrow("HTTP 500");
    expect(keychain.size).toBe(0);
    expect((await state.load(root)).resources).toHaveLength(0);
  });
});

describe("Terraform recipes (aws/*)", () => {
  test("ec2 plans its network dependency; rollback removes every generated file", async () => {
    const plan = await planAdd(request({ recipe: "aws/ec2", name: "web" }), ctx);
    expect(plan.resources.map((r) => [r.name, r.recipe])).toEqual([["network", "aws/vpc"], ["web", "aws/ec2"]]);
    expect(plan.resources[1]!.dependsOn).toEqual({ network: "network" });

    const op = await applyPlan("add aws/ec2", plan.changes, ctx);
    const web = await Bun.file(path.join(root, "iac/terraform/web.tf")).text();
    expect(web).toContain("module.network.subnet_id");
    expect(await exists("iac/terraform/modules/aws-ec2/main.tf")).toBe(true);
    expect(await Bun.file(path.join(root, "iac/terraform/versions.tf")).text()).toContain('source = "hashicorp/aws"');
    expect(await Bun.file(path.join(root, ".gitignore")).text()).toContain("iac/terraform/*.tfstate");
    expect(fetchCalls).toBe(0); // terraform recipes touch no API at add time

    await undoSteps(op, ctx);
    for (const f of ["web.tf", "network.tf", "versions.tf", "modules/aws-ec2/main.tf", "modules/aws-vpc/main.tf"]) expect(await exists(`iac/terraform/${f}`)).toBe(false);
    expect((await state.load(root)).resources).toHaveLength(0);
  });

  test("a second instance reuses the existing network and the shared module", async () => {
    await applyPlan("add", (await planAdd(request({ recipe: "aws/ec2", name: "web" }), ctx)).changes, ctx);
    const plan = await planAdd(request({ recipe: "aws/ec2", name: "worker" }), ctx);
    expect(plan.resources.map((r) => r.name)).toEqual(["worker"]);
    expect(plan.resources[0]!.dependsOn).toEqual({ network: "network" });
    expect(plan.changes.some((c) => c.summary.startsWith("Generate module"))).toBe(false);
  });

  test("several candidates ask, and --use answers without asking", async () => {
    await applyPlan("add", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    await applyPlan("add", (await planAdd(request({ recipe: "aws/vpc", name: "staging" }), ctx)).changes, ctx);
    const asked: string[] = [];
    const plan = await planAdd(request({ recipe: "aws/ec2", name: "web", choose: async (q, o) => (asked.push(q), o[1]!) }), ctx);
    expect(asked).toHaveLength(1);
    expect(plan.resources[0]!.dependsOn).toEqual({ network: "staging" });
    const explicit = await planAdd(request({ recipe: "aws/ec2", name: "api", use: { network: "main" } }), ctx);
    expect(explicit.resources[0]!.dependsOn).toEqual({ network: "main" });
  });

  test("rollback keeps a generated file someone edited", async () => {
    const op = await applyPlan("add", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    await Bun.write(path.join(root, "iac/terraform/main.tf"), "# my edits\n");
    await undoSteps(op, ctx);
    expect(await exists("iac/terraform/main.tf")).toBe(true);
  });

  test("names must be unique and valid", async () => {
    await applyPlan("add", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    await expect(planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).rejects.toThrow("already has a resource");
    await expect(planAdd(request({ recipe: "aws/vpc", name: "Bad_Name" }), ctx)).rejects.toThrow("Invalid name");
  });
});

describe("manual recipes (anthropic/api-key)", () => {
  const paste = (value: string) => request({ recipe: "anthropic/api-key", name: "anthropic", secret: async () => Secret.of(value) });

  test("dry runs never ask for the key", async () => {
    const plan = await planAdd(request({ recipe: "anthropic/api-key", name: "anthropic" }), { ...ctx, dryRun: true });
    expect(plan.changes[0]!.summary).toContain("store it as ANTHROPIC_API_KEY");
    expect(fetchCalls).toBe(0);
  });

  test("a working key is verified, stored, and rollback removes it", async () => {
    const op = await applyPlan("add anthropic/api-key", (await planAdd(paste(GOOD_ANTHROPIC_KEY), ctx)).changes, ctx);
    expect(keychain.get("dev.sikrets.vault.demo/ANTHROPIC_API_KEY")).toBe(GOOD_ANTHROPIC_KEY);
    const [res] = (await state.load(root)).resources;
    expect(res).toMatchObject({ name: "anthropic", strategy: "manual", applied: true, envKeys: ["ANTHROPIC_API_KEY"] });
    expect(JSON.stringify(res)).not.toContain("sk-ant");
    await undoSteps(op, ctx);
    expect(keychain.size).toBe(0);
    expect((await state.load(root)).resources).toHaveLength(0);
  });

  test("something that isn't a key is rejected before any network call", async () => {
    await expect(applyPlan("add", (await planAdd(paste("hello"), ctx)).changes, ctx)).rejects.toThrow("doesn't look like");
    expect(fetchCalls).toBe(0);
    expect(keychain.size).toBe(0);
  });

  test("a revoked or mistyped key is rejected and nothing is stored", async () => {
    await expect(applyPlan("add", (await planAdd(paste("sk-ant-api03-revokedrevokedrevoked99"), ctx)).changes, ctx)).rejects.toThrow("rejected this key");
    expect(keychain.size).toBe(0);
    expect((await state.load(root)).resources).toHaveLength(0);
  });
});

describe("stand-ins", () => {
  const dotenv = () => Bun.file(path.join(root, ".env")).text();

  test("add writes a stand-in to .env, never the real token; rollback removes only its lines", async () => {
    await Bun.write(path.join(root, ".env"), "# mine\nPORT=3000\n");
    const op = await applyPlan("add", (await planAdd(request({}), ctx)).changes, ctx);
    const text = await dotenv();
    expect(text).toContain("PORT=3000");
    expect(text).toContain('CACHE_REDIS_REST_URL="https://happy-fox-123.upstash.io"');
    expect(text).not.toContain("tok_live_secret_value");
    const token = /CACHE_REDIS_REST_TOKEN="([^"]+)"/.exec(text)![1]!;
    expect(isStandIn(token)).toBe(true);
    expect((await Bun.file(path.join(root, ".gitignore")).text()).split("\n")).toContain(".env");

    await undoSteps(op, ctx);
    expect(await dotenv()).toBe("# mine\nPORT=3000\n");
    expect(keychain.size).toBe(0); // real token and stand-in both gone
  });

  test("stand-ins are stable, and --real resolves to the real values", async () => {
    await applyPlan("add", (await planAdd(request({}), ctx)).changes, ctx);
    const vault = await openVault("demo", "keychain");
    const { resources } = await state.load(root);
    const first = await envValues(vault, resources, false);
    const again = await envValues(vault, resources, false);
    expect(first.get("CACHE_REDIS_REST_TOKEN")!.reveal()).toBe(again.get("CACHE_REDIS_REST_TOKEN")!.reveal());
    const real = await envValues(vault, resources, true);
    expect(real.get("CACHE_REDIS_REST_TOKEN")!.reveal()).toBe("tok_live_secret_value");
    expect(real.get("CACHE_REDIS_REST_URL")!.reveal()).toBe(first.get("CACHE_REDIS_REST_URL")!.reveal());
  });

  test("stand-ins are random and well-formed", async () => {
    const { newStandIn } = await import("./core/standin.ts");
    const a = newStandIn().reveal();
    const b = newStandIn().reveal();
    expect(isStandIn(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("sikrets.json", () => {
  test("defaults come from the directory; strict validation rejects typos", async () => {
    const { loadConfig, validateConfig } = await import("./core/config.ts");
    const c = await loadConfig(root);
    expect(c).toMatchObject({ vault: "ssm", env: ".env", iac: { tool: "terraform", dir: "iac/terraform" } });
    expect(() => validateConfig({ projct: "x" }, root)).toThrow("unknown field projct");
    expect(() => validateConfig({ vault: "s3" }, root)).toThrow('"vault"');
    expect(() => validateConfig({ env: "../secrets" }, root)).toThrow('"env"');
    expect(() => validateConfig({ project: "Shop App" }, root)).toThrow('"project"');
  });

  test("the project name and vault come from sikrets.json", async () => {
    const { projectContext } = await import("./core/config.ts");
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "shop", vault: "keychain", env: ".env.local" }));
    delete process.env.SIKRETS_VAULT;
    const { config, ctx: c } = await projectContext(root, { log: () => {} });
    expect([c.project, c.vault, config.env]).toEqual(["shop", "keychain", ".env.local"]);
    process.env.SIKRETS_VAULT = "ssm"; // per-run override
    expect((await projectContext(root, { log: () => {} })).ctx.vault).toBe("ssm");
    process.env.SIKRETS_VAULT = "keychain";
  });
});
