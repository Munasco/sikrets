import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { planAdd, type AddRequest } from "./core/add.ts";
import { withLock } from "./core/fs.ts";
import { applyPlan, undoSteps, type Context } from "./core/plan.ts";
import { journal, newOperation, state, transition } from "./core/state.ts";
import { isGenerated, writeGenerated } from "./core/files.ts";
import "./core/vault.ts";
import "./commands/apply.ts";

// Crash-in-the-middle, concurrent-writer and restart cases for the state machines behind add,
// apply, rollback, rotate and connect. Fake Upstash and keychain; nothing real is touched.

let databases: Record<string, { database_id: string; database_name: string; endpoint: string; rest_token: string }>;
let resets: number;
let createThenDrop: boolean;
let failDeletes: number;
const keychain = new Map<string, string>();
let root: string;
let ctx: Context;

beforeEach(async () => {
  databases = {};
  resets = 0;
  createThenDrop = false;
  failDeletes = 0;
  keychain.clear();
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-crash-"));
  ctx = { root, project: "demo", vault: "keychain", dryRun: false, log: () => {} };
  process.env.SIKRETS_VAULT = "keychain";
  process.env.SIKRETS_CONFIG_DIR = path.join(root, ".home");
  process.env.UPSTASH_EMAIL = "dev@example.com";
  process.env.UPSTASH_API_KEY = "test-management-key";
  await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo" }));

  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => {
    if (failDeletes > 0 && failDeletes--) throw new Error("keychain locked");
    return keychain.delete(`${service}/${name}`);
  });
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && url.pathname === "/v2/redis/databases") return json(Object.values(databases));
    if (method === "POST" && url.pathname === "/v2/redis/database") {
      const body = JSON.parse(String(init!.body)) as { database_name: string };
      const db = { database_id: `db_${body.database_name}`, database_name: body.database_name, endpoint: "happy-fox-123", rest_token: "tok_live_secret_value" };
      databases[db.database_id] = db;
      // The database exists, but the response never arrives (Ctrl-C, dropped connection).
      if (createThenDrop) throw new Error("socket hang up");
      return json(db);
    }
    if (method === "POST" && url.pathname.startsWith("/v2/redis/reset-password/")) {
      resets++;
      const db = databases[url.pathname.split("/").pop()!]!;
      db.rest_token = `tok_rotated_${resets}`;
      return json(db);
    }
    if (method === "DELETE" && url.pathname.startsWith("/v2/redis/database/")) {
      const id = url.pathname.split("/").pop()!;
      if (!databases[id]) return json({ error: "database not found" }, 404);
      delete databases[id];
      return new Response("", { status: 200 });
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const request = (over: Partial<AddRequest> = {}): AddRequest => ({
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

async function inProject<T>(fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
  }
}

describe("add journal", () => {
  test("a create whose response is lost is still journaled, and undone by name", async () => {
    createThenDrop = true;
    await expect(applyPlan("add upstash/redis", (await planAdd(request(), ctx)).changes, ctx)).rejects.toThrow("socket hang up");
    expect(Object.keys(databases)).toHaveLength(0);
    const [op] = await journal.load(root);
    expect(op!.status).toBe("rolled-back");
    expect(op!.steps.map((s) => [s.kind, s.status])).toEqual([["api.destroy", "undone"]]);
  });

  test("after a crash mid-add, rollback finds the pending create by name (restart)", async () => {
    // What a process killed during the create call leaves behind: a running op, a pending step.
    const op = newOperation("add upstash/redis");
    op.steps.push({ kind: "api.destroy", summary: "Delete cache", data: { recipe: "upstash/redis", name: "cache" }, status: "pending" });
    await journal.record(root, op);
    databases.db_cache = { database_id: "db_cache", database_name: "cache", endpoint: "x", rest_token: "t" };

    const { run } = await import("./commands/rollback.ts");
    await inProject(() => run([], { yes: true }));
    expect(Object.keys(databases)).toHaveLength(0);
    expect((await journal.load(root))[0]!.status).toBe("rolled-back");
  });

  test("a rollback that fails midway resumes, and a resource already deleted counts as done", async () => {
    const op = await applyPlan("add upstash/redis", (await planAdd(request(), ctx)).changes, ctx);
    failDeletes = 1; // the env step's stand-in delete fails once
    await expect(undoSteps(op, ctx)).rejects.toThrow("keychain locked");
    let saved = (await journal.load(root))[0]!;
    expect(saved.status).toBe("rolling-back");
    expect(saved.steps.every((s) => s.status === "done")).toBe(true);

    delete databases.db_cache; // someone deleted it in the dashboard meanwhile → DELETE answers 404
    await undoSteps(saved, ctx);
    saved = (await journal.load(root))[0]!;
    expect(saved.status).toBe("rolled-back");
    expect(saved.steps.every((s) => s.status === "undone")).toBe(true);
    expect((await state.load(root)).resources).toHaveLength(0);
    expect(keychain.size).toBe(0);
  });

  test("if undoing fails too, the error keeps the cause and says how to finish", async () => {
    const plan = await planAdd(request(), ctx);
    plan.changes[2]!.apply = async () => {
      throw new Error("disk full");
    };
    failDeletes = 99;
    await expect(applyPlan("add", plan.changes, ctx)).rejects.toThrow(/disk full\. Undoing it also failed .*sikrets rollback op_/);
  });

  test("undo deletes from the vault the add wrote to, not the current SIKRETS_VAULT", async () => {
    const op = await applyPlan("add", (await planAdd(request(), ctx)).changes, ctx);
    // If this reached for SSM it would fail: no AWS here.
    await undoSteps(op, { ...ctx, vault: "ssm" });
    expect(keychain.size).toBe(0);
  });

  test("operations can't move backwards", () => {
    const op = newOperation("add");
    transition(op, "applied");
    transition(op, "rolling-back");
    transition(op, "rolled-back");
    expect(() => transition(op, "rolling-back")).toThrow("can't become rolling-back");
  });

  test("journals written before statuses existed still load", async () => {
    await Bun.write(path.join(root, ".sikrets/journal.json"), JSON.stringify([{ id: "op_old", command: "add", at: "x", steps: [{ kind: "state.remove", summary: "s", data: { name: "a" } }], rolledBackAt: "y" }]));
    const [op] = await journal.load(root);
    expect(op).toMatchObject({ status: "rolled-back", steps: [{ status: "undone" }] });
  });
});

describe("state files", () => {
  test("concurrent writers don't lose each other's resources", async () => {
    const res = (name: string) => ({ name, recipe: "aws/vpc" as const, provider: "aws", strategy: "terraform" as const, inputs: {}, dependsOn: {}, envKeys: [], outputs: {}, applied: false, createdAt: "x" });
    await Promise.all(Array.from({ length: 20 }, (_, i) => state.upsert(ctx, res(`r${i}`))));
    expect((await state.load(root)).resources).toHaveLength(20);
    const ops = Array.from({ length: 20 }, () => newOperation("add"));
    await Promise.all(ops.map((op) => journal.record(root, op)));
    expect(new Set((await journal.load(root)).map((o) => o.id)).size).toBe(20);
  });

  test("a lock left by a dead process is taken over", async () => {
    const file = path.join(root, ".sikrets/state.json");
    await Bun.write(`${file}.lock`, "999999 2020-01-01T00:00:00Z\n");
    let ran = false;
    await withLock(file, async () => void (ran = true), 1000);
    expect(ran).toBe(true);
    expect(await Bun.file(`${file}.lock`).exists()).toBe(false);
  });

  test("state recorded for one project name is refused under another", async () => {
    await applyPlan("add", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    expect((await state.load(root)).project).toBe("demo");
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "renamed" }));
    const { projectContext } = await import("./core/config.ts");
    await expect(projectContext(root, { log: () => {} })).rejects.toThrow('belongs to project "demo"');
  });

  test("a crash between a generated file and sikrets.lock doesn't make it look hand-edited", async () => {
    await writeGenerated(root, "iac/terraform/versions.tf", "v1\n");
    // Simulate the crash: the lock already says v2 (with v1 as previous), the file is still v1.
    const lockPath = path.join(root, "sikrets.lock");
    const lock = await Bun.file(lockPath).json();
    const hash = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
    await Bun.write(lockPath, JSON.stringify({ ...lock, files: { "iac/terraform/versions.tf": hash("v2\n") }, previous: { "iac/terraform/versions.tf": hash("v1\n") } }));
    expect(await isGenerated(root, "iac/terraform/versions.tf")).toBe(true);
    await writeGenerated(root, "iac/terraform/versions.tf", "v2\n");
    expect((await Bun.file(lockPath).json()).previous).toBeUndefined();
  });

  test("sikrets.json refuses fields it would ignore", async () => {
    const { validateConfig } = await import("./core/config.ts");
    expect(() => validateConfig({ connections: { upstash: "work" } }, root)).toThrow('"connections"');
    expect(validateConfig({ connections: {} }, root).project).toBeString(); // older init output still loads
    expect(() => validateConfig({ iac: { tool: "terraform", dir: "infra" } }, root)).toThrow('"iac"');
  });
});

describe("apply", () => {
  const fakeTerraform = async (opts: { applyExit?: number; state?: string[]; outputs?: object }) => {
    const bin = path.join(root, ".home/terraform");
    await Bun.write(path.join(root, ".home/state.txt"), (opts.state ?? []).join("\n"));
    await Bun.write(path.join(root, ".home/outputs.json"), JSON.stringify(opts.outputs ?? {}));
    await writeFile(
      bin,
      `#!/bin/sh\necho "$*" >> "${root}/.home/calls.txt"\ncase "$1" in\n  apply) exit ${opts.applyExit ?? 0};;\n  output) cat "${root}/.home/outputs.json";;\n  state) cat "${root}/.home/state.txt";;\nesac\nexit 0\n`,
    );
    await chmod(bin, 0o755);
    process.env.SIKRETS_TERRAFORM = bin;
  };
  const calls = async () => (await Bun.file(path.join(root, ".home/calls.txt")).text()).trim().split("\n");
  afterEach(() => void delete process.env.SIKRETS_TERRAFORM);

  test("a failed apply is journaled first, blocks rolling back the add, and can be rolled back", async () => {
    await applyPlan("add aws/vpc", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    await fakeTerraform({ applyExit: 1 });
    const apply = await import("./commands/apply.ts");
    await expect(inProject(() => apply.run([], { yes: true }))).rejects.toThrow("terraform apply exited with 1");
    const ops = await journal.load(root);
    expect(ops.at(-1)).toMatchObject({ command: "apply", status: "running", steps: [{ kind: "terraform.destroy", status: "pending" }] });

    const rollback = await import("./commands/rollback.ts");
    await expect(inProject(() => rollback.run([ops[0]!.id], { yes: true }))).rejects.toThrow("still exist in the cloud");
    await inProject(() => rollback.run([], { yes: true })); // the apply
    expect((await calls()).at(-1)).toStartWith("destroy -input=false -auto-approve -target=module.main");
    await inProject(() => rollback.run([], { yes: true })); // now the add
    expect((await state.load(root)).resources).toHaveLength(0);
  });

  test("a resource is live when Terraform has it, even with no outputs yet", async () => {
    await applyPlan("add aws/vpc", (await planAdd(request({ recipe: "aws/vpc", name: "main" }), ctx)).changes, ctx);
    await fakeTerraform({ state: ["module.main.aws_vpc.this"] });
    const apply = await import("./commands/apply.ts");
    await inProject(() => apply.run([], { yes: true }));
    expect((await state.load(root)).resources[0]).toMatchObject({ applied: true, vault: "keychain" });
    expect((await journal.load(root)).at(-1)).toMatchObject({ command: "apply", status: "applied", steps: [{ status: "done" }] });
  });
});

describe("rotate", () => {
  const rotate = async (opts: Record<string, unknown> = {}) => {
    const { run } = await import("./commands/rotate.ts");
    return inProject(() => run(["cache"], { yes: true, ...opts }));
  };
  const token = () => keychain.get("dev.sikrets.vault.demo/CACHE_REDIS_REST_TOKEN");

  test("a vault that can't take writes stops rotation before the provider revokes anything", async () => {
    await applyPlan("add", (await planAdd(request(), ctx)).changes, ctx);
    const put = spyOn(Bun.secrets, "set").mockImplementation(async () => {
      throw new Error("vault session expired");
    });
    await expect(rotate()).rejects.toThrow("vault session expired");
    put.mockRestore();
    expect(resets).toBe(0);
    expect((await state.load(root)).resources[0]!.rotation).toBeUndefined();
  });

  test("a vault write failing after the provider rotated is resumed without rotating again", async () => {
    await applyPlan("add", (await planAdd(request(), ctx)).changes, ctx);
    // Let the preflight write (the 1st to the vault) and the recovery copy through; fail the real write.
    let vaultWrites = 0;
    const put = spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => {
      if (service === "dev.sikrets.vault.demo" && ++vaultWrites === 2) throw new Error("vault unreachable");
      keychain.set(`${service}/${name}`, value);
    });
    await expect(rotate()).rejects.toThrow("vault unreachable");
    put.mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
    expect(resets).toBe(1);
    expect((await state.load(root)).resources[0]!.rotation).toMatchObject({ status: "issued" });

    await rotate();
    expect(resets).toBe(1); // no second reset: that would revoke the key we're holding
    expect(token()).toBe("tok_rotated_1");
    expect((await state.load(root)).resources[0]!.rotation).toBeUndefined();
    expect([...keychain.keys()].some((k) => k.startsWith("dev.sikrets.recovery."))).toBe(false);
  });
});

describe("connect", () => {
  const provider = (verify: () => Promise<void>) => ({
    id: "upstash",
    name: "Upstash",
    loginUrl: "",
    isLoggedIn: async () => true,
    login: async () => {},
    mint: { key: "api-key", manageUrl: "https://console.example/keys", run: async () => "minted-key-value-0123456789abcdef", verify },
  });

  test("a minted key is recorded before minting and only becomes active once verified", async () => {
    const { mintKey } = await import("./commands/connect.ts");
    const { updateConnection, listConnections, keysToRevoke } = await import("./store.ts");
    await updateConnection("upstash", () => ({ provider: "upstash", account: "a@x.dev", mode: "watch", connectedAt: "x" }));
    await expect(mintKey(provider(async () => { throw new Error("Upstash rejected the new API key"); }), {} as Page, "a@x.dev", {})).rejects.toThrow("revoke");
    expect(keychain.has("dev.sikrets.upstash/a@x.dev#api-key")).toBe(false);
    let conn = (await listConnections())[0]!;
    expect(conn.keys!.map((k) => k.status)).toEqual(["failed"]);

    await mintKey(provider(async () => {}), {} as Page, "a@x.dev", {});
    conn = (await listConnections())[0]!;
    expect(conn.keys!.at(-1)!.status).toBe("active");
    expect(keychain.get("dev.sikrets.upstash/a@x.dev#api-key")).toBe("minted-key-value-0123456789abcdef");
    expect(keysToRevoke(conn).map((k) => k.status)).toEqual(["failed"]);
  });
});

describe("auto-rotate", () => {
  const DAY = 86_400_000;
  const addDue = async (vault = "keychain") => {
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo", vault }));
    await applyPlan("add", (await planAdd(request({ rotateEvery: "30d", autoRotate: true }), ctx)).changes, ctx);
    const [r] = (await state.load(root)).resources;
    await state.upsert(ctx, { ...r!, createdAt: new Date(Date.now() - 31 * DAY).toISOString() });
  };

  test("two processes due at once rotate the key once", async () => {
    await addDue();
    const { autoRotate } = await import("./core/autorotate.ts");
    const said: string[] = [];
    await Promise.all([autoRotate(root, (m) => said.push(m)), autoRotate(root, (m) => said.push(m))]);
    expect(resets).toBe(1);
    expect(said).toEqual(["sikrets: auto-rotated cache"]);
    expect(keychain.get("dev.sikrets.vault.demo/CACHE_REDIS_REST_TOKEN")).toBe("tok_rotated_1");
  });

  test("a one-off SIKRETS_VAULT never auto-rotates the project's shared key", async () => {
    await addDue("ssm"); // stored in the keychain because SIKRETS_VAULT=keychain
    const { autoRotate } = await import("./core/autorotate.ts");
    await autoRotate(root, () => {});
    expect(resets).toBe(0);
  });

  test("after an unknown outcome it backs off; a key saved locally is resumed at once", async () => {
    const { autoRotateDue } = await import("./core/schedule.ts");
    await addDue();
    const [r] = (await state.load(root)).resources;
    const now = Date.now();
    expect(autoRotateDue([{ ...r!, rotation: { status: "requested", at: new Date(now - 60_000).toISOString() } }], "30d", now)).toHaveLength(0);
    expect(autoRotateDue([{ ...r!, rotation: { status: "requested", at: new Date(now - 20 * 60_000).toISOString() } }], "30d", now)).toHaveLength(1);
    const fresh = { ...r!, createdAt: new Date(now).toISOString() };
    expect(autoRotateDue([{ ...fresh, rotation: { status: "issued", at: new Date(now).toISOString(), outputs: ["rest_token"] } }], "30d", now)).toHaveLength(1);
    expect(autoRotateDue([{ ...fresh, strategy: "manual" }], "1m", now + DAY)).toHaveLength(0); // hand-edited onto a dashboard key
  });

  test("run warns about an expired key", async () => {
    await addDue();
    const [r] = (await state.load(root)).resources;
    await state.upsert(ctx, { ...r!, expiresAt: new Date(Date.now() - 2 * DAY).toISOString() });
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((m: string) => void errors.push(m));
    const { run } = await import("./commands/run.ts");
    await inProject(() => run(["true"], {}));
    spy.mockRestore();
    expect(errors).toEqual(["sikrets: cache's key expired 2d ago; replace it: sikrets rotate cache"]);
  });
});
