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
  process.env.SIKRETS_CONFIG_DIR = path.join(root, ".sikrets-config");
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
    if (method === "POST" && url.pathname.startsWith("/v2/redis/reset-password/")) {
      const db = databases[url.pathname.split("/").pop()!]!;
      db.rest_token = "tok_rotated_value";
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

describe("activity", () => {
  test("records names and outcomes, never values; last-used comes from runs", async () => {
    const { record, readActivity, lastUsed } = await import("./core/activity.ts");
    await record(root, { kind: "env.pull", detail: "2 value(s) to .env", keys: ["CACHE_REDIS_REST_TOKEN"], real: false });
    await record(root, { kind: "run", detail: "bun (exit 0, 0.4s)", keys: ["CACHE_REDIS_REST_TOKEN"], exitCode: 0, ms: 400 });
    await Bun.write(path.join(root, ".sikrets/activity.jsonl"), (await Bun.file(path.join(root, ".sikrets/activity.jsonl")).text()) + '{"torn');
    const entries = await readActivity(root);
    expect(entries.map((e) => e.kind)).toEqual(["env.pull", "run"]); // torn last line skipped
    expect(lastUsed(entries).get("CACHE_REDIS_REST_TOKEN")).toBe(entries[1]!.at);
    expect(await Bun.file(path.join(root, ".sikrets/activity.jsonl")).text()).not.toContain("tok_live");
    expect((await Bun.file(path.join(root, ".gitignore")).text()).split("\n")).toContain(".sikrets/activity.jsonl");
  });
});

describe("rotate", () => {
  test("replaces the real token, keeps the stand-in, sets the next due date", async () => {
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo" }));
    await applyPlan("add", (await planAdd(request({ rotateEvery: "30d" }), ctx)).changes, ctx);
    const before = await Bun.file(path.join(root, ".env")).text();
    const { run } = await import("./commands/rotate.ts");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await run(["cache"], { yes: true, json: true });
    } finally {
      process.chdir(cwd);
    }
    expect(keychain.get("dev.sikrets.vault.demo/CACHE_REDIS_REST_TOKEN")).toBe("tok_rotated_value");
    expect(await Bun.file(path.join(root, ".env")).text()).toBe(before); // stand-ins unchanged
    const [res] = (await state.load(root)).resources;
    expect(res!.lastRotatedAt).toBeString();
    expect(Date.parse(res!.rotateBy!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const { readActivity } = await import("./core/activity.ts");
    expect((await readActivity(root)).at(-1)).toMatchObject({ kind: "rotate", keys: ["CACHE_REDIS_REST_TOKEN"] });
  });

  test("Terraform resources are refused with guidance", async () => {
    await applyPlan("add", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    const { state: st } = await import("./core/state.ts");
    const [vpc] = (await st.load(root)).resources;
    await st.upsert(root, { ...vpc!, applied: true });
    const { run } = await import("./commands/rotate.ts");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await expect(run(["main"], { yes: true })).rejects.toThrow("managed by Terraform");
    } finally {
      process.chdir(cwd);
    }
  });

  test("durations are strict", async () => {
    const { parseDuration, until } = await import("./core/ttl.ts");
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    for (const bad of ["30", "1 day", "0d", "-2h"]) expect(() => parseDuration(bad)).toThrow();
    expect(until(new Date(Date.now() + 6 * 86_400_000 + 1000).toISOString())).toBe("in 6d");
    expect(until(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("overdue by 2d");
  });
});

describe("get", () => {
  test("provisions in personal area with stand-ins, 24h TTL, and clean stdout", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const { run } = await import("./commands/get.ts");
      await run(["upstash/redis"], {});
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    // Progress goes to stderr
    expect(errs.some((e) => e.includes("Create upstash/redis"))).toBe(true);

    // Stdout has exactly KEY=value lines
    expect(logs.length).toBe(2);
    const urlLine = logs.find((l) => l.startsWith("REDIS_REDIS_REST_URL="));
    const tokenLine = logs.find((l) => l.startsWith("REDIS_REDIS_REST_TOKEN="));
    expect(urlLine).toBe("REDIS_REDIS_REST_URL=https://happy-fox-123.upstash.io");
    expect(tokenLine).toBeDefined();
    const token = tokenLine!.split("=")[1]!;
    expect(isStandIn(token)).toBe(true);

    // Resource is saved in personal area with 24h TTL
    const { personalDir } = await import("./core/config.ts");
    const { state: st } = await import("./core/state.ts");
    const [res] = (await st.load(personalDir())).resources;
    expect(res).toBeDefined();
    expect(res!.name).toBe("redis");
    expect(res!.applied).toBe(true);
    expect(res!.rotateBy).toBeString();
    const ttlMs = Date.parse(res!.rotateBy!) - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 3_600_000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3_600_000 + 5000);
  });

  test("--real prints actual secrets", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const { run } = await import("./commands/get.ts");
      await run(["upstash/redis", "--name", "realdb"], { real: true, name: "realdb" });
    } finally {
      console.log = origLog;
    }

    expect(logs).toContain("REALDB_REDIS_REST_TOKEN=tok_live_secret_value");
  });

  test("--json returns an object", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const { run } = await import("./commands/get.ts");
      await run(["upstash/redis", "--name", "jsondb"], { json: true, name: "jsondb" });
    } finally {
      console.log = origLog;
    }

    const obj = JSON.parse(logs[0]!) as Record<string, string>;
    expect(obj.JSONDB_REDIS_REST_URL).toBe("https://happy-fox-123.upstash.io");
    expect(isStandIn(obj.JSONDB_REDIS_REST_TOKEN!)).toBe(true);
  });

  test("reuses resources with an existing --name instead of creating another", async () => {
    const { run } = await import("./commands/get.ts");
    const logs1: string[] = [];
    const logs2: string[] = [];
    const origLog = console.log;

    console.log = (...args: unknown[]) => logs1.push(args.map(String).join(" "));
    try {
      await run(["upstash/redis"], { name: "cache" });
    } finally {
      console.log = origLog;
    }

    const callsAfterFirst = fetchCalls;

    console.log = (...args: unknown[]) => logs2.push(args.map(String).join(" "));
    try {
      await run(["upstash/redis"], { name: "cache" });
    } finally {
      console.log = origLog;
    }

    // No new fetch calls were made to Upstash on second run
    expect(fetchCalls).toBe(callsAfterFirst);
    expect(logs2).toEqual(logs1);

    const { personalDir } = await import("./core/config.ts");
    const { state: st } = await import("./core/state.ts");
    const resources = (await st.load(personalDir())).resources.filter((r) => r.name === "cache");
    expect(resources.length).toBe(1);
  });

  test("rollback --personal removes personal resources", async () => {
    const { run: runGet } = await import("./commands/get.ts");
    await runGet(["upstash/redis"], { name: "throwaway" });

    const { personalDir } = await import("./core/config.ts");
    const { state: st } = await import("./core/state.ts");
    expect((await st.load(personalDir())).resources.some((r) => r.name === "throwaway")).toBe(true);

    const { run: runRollback } = await import("./commands/rollback.ts");
    await runRollback([], { personal: true, yes: true });

    expect((await st.load(personalDir())).resources.some((r) => r.name === "throwaway")).toBe(false);
  });

  test("Terraform recipes are refused in get", async () => {
    const { run } = await import("./commands/get.ts");
    await expect(run(["aws/ec2"], {})).rejects.toThrow("managed by Terraform");
  });
});

