import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPlan, undoSteps, type Context } from "./core/plan.ts";
import { journal, state } from "./core/state.ts";
import { planRedis } from "./providers/upstash/redis.ts";
import "./core/files.ts";
import "./core/vault.ts";

// Fake Upstash account and in-memory keychain, so the test never touches real infra or secrets.
let databases: Record<string, { database_id: string; database_name: string; endpoint: string }>;
let failCreate = false;
const keychain = new Map<string, string>();
let root: string;
let ctx: Context;

beforeEach(async () => {
  databases = {};
  failCreate = false;
  keychain.clear();
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-test-"));
  ctx = { root, project: "demo", dryRun: false, log: () => {} };
  process.env.UPSTASH_EMAIL = "dev@example.com";
  process.env.UPSTASH_API_KEY = "test-key";

  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && url.pathname === "/v2/redis/databases") return json(Object.values(databases));
    if (method === "POST" && url.pathname === "/v2/redis/database") {
      if (failCreate) return json({ error: "boom" }, 500);
      const body = JSON.parse(String(init!.body));
      const db = { database_id: `db_${body.database_name}`, database_name: body.database_name, endpoint: "happy-fox-123", rest_token: "tok_123" };
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

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (rel: string) => readFile(path.join(root, rel)).then(() => true, () => false);

test("dry run describes the add and creates nothing", async () => {
  const changes = await planRedis({ name: "cache", region: "us-east-1", plan: "payg", budget: 20 }, { ...ctx, dryRun: true });
  expect(changes.map((c) => c.summary)).toHaveLength(4);
  expect(changes[0]!.cost).toBe("pay as you go, capped at $20/mo");
  expect(Object.keys(databases)).toHaveLength(0);
  expect(keychain.size).toBe(0);
  expect(await exists("iac/terraform/upstash-cache.tf")).toBe(false);
});

test("add then rollback leaves nothing behind", async () => {
  const op = await applyPlan("add upstash/redis", await planRedis({ name: "cache", region: "us-east-1", plan: "free" }, ctx), ctx);
  expect(Object.keys(databases)).toEqual(["db_cache"]);
  expect(keychain.get("dev.sikrets.vault.demo/CACHE_REDIS_REST_URL")).toBe("https://happy-fox-123.upstash.io");
  expect(await readFile(path.join(root, "iac/terraform/upstash-cache.tf"), "utf8")).toContain('id = "db_cache"');
  expect((await state.load(root)).resources.map((r) => r.id)).toEqual(["upstash/redis/cache"]);
  expect((await journal.load(root))[0]!.steps).toHaveLength(4);

  await undoSteps(op, ctx);
  expect(Object.keys(databases)).toHaveLength(0);
  expect(keychain.size).toBe(0);
  expect(await exists("iac/terraform/upstash-cache.tf")).toBe(false);
  expect((await state.load(root)).resources).toHaveLength(0);
});

test("a failed add undoes the steps that already ran", async () => {
  const changes = await planRedis({ name: "cache", region: "us-east-1", plan: "free" }, ctx);
  // Make the third step (IaC generation) fail after the database and vault steps succeed.
  changes[2]!.apply = async () => {
    throw new Error("disk full");
  };
  await expect(applyPlan("add upstash/redis", changes, ctx)).rejects.toThrow("disk full");
  expect(Object.keys(databases)).toHaveLength(0);
  expect(keychain.size).toBe(0);
  expect((await journal.load(root))[0]!.rolledBackAt).toBeString();
});

test("a provider error leaves nothing to undo", async () => {
  failCreate = true;
  await expect(applyPlan("add upstash/redis", await planRedis({ name: "cache", region: "us-east-1", plan: "free" }, ctx), ctx)).rejects.toThrow("HTTP 500");
  expect(keychain.size).toBe(0);
});

test("rollback keeps a generated file someone edited", async () => {
  const op = await applyPlan("add upstash/redis", await planRedis({ name: "cache", region: "us-east-1", plan: "free" }, ctx), ctx);
  await writeFile(path.join(root, "iac/terraform/upstash-cache.tf"), "# my edits\n");
  await undoSteps(op, ctx);
  expect(await exists("iac/terraform/upstash-cache.tf")).toBe(true);
  expect(Object.keys(databases)).toHaveLength(0);
});

test("refuses to add a database name that already exists", async () => {
  databases.db_cache = { database_id: "db_cache", database_name: "cache", endpoint: "x" };
  await expect(planRedis({ name: "cache", region: "us-east-1", plan: "free" }, ctx)).rejects.toThrow("already exists");
});
