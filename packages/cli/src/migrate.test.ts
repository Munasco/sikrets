import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDataKey } from "./core/datakey.ts";
import { envelopeKind, projectKey, sealValue } from "./core/envelope.ts";
import { migrateEncrypt } from "./core/migrate.ts";
import { ssmParams, ssmVault } from "./core/vault.ts";
import { fakeSsm } from "./fake-ssm.ts";

// Mocked Parameter Store holding a project as it looks on main today: plaintext SecureStrings.
const keychain = new Map<string, string>();
let ssm: ReturnType<typeof fakeSsm>;
const LEGACY = { CACHE_REDIS_REST_TOKEN: "tok_live_secret_value", CACHE_REDIS_REST_URL: "https://happy-fox-123.upstash.io", ANTHROPIC_API_KEY: "sk-ant-real" };

let dir: string;

beforeEach(async () => {
  keychain.clear();
  dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-migrate-"));
  process.env.SIKRETS_CONFIG_DIR = dir;
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  ssm = fakeSsm();
  for (const [k, v] of Object.entries(LEGACY)) {
    ssm.params.set(`/sikrets/shop/${k}`, v);
    ssm.history.set(`/sikrets/shop/${k}`, [v]);
  }
  ssm.params.set("/sikrets/blog/OTHER_PROJECT", "left alone");
});

afterEach(async () => {
  delete process.env.SIKRETS_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

const setup = async () => {
  const params = await ssmParams("shop", ssm.client);
  return { params, key: projectKey(await ensureDataKey(), "shop") };
};

describe("migrate encrypt", () => {
  test("seals every plaintext value in place, and they still read back", async () => {
    const { params, key } = await setup();
    const result = await migrateEncrypt(params, key);
    expect(result).toEqual({ sealed: ["ANTHROPIC_API_KEY", "CACHE_REDIS_REST_TOKEN", "CACHE_REDIS_REST_URL"], already: [], unreadable: [], purged: [], changed: [] });
    for (const [k, v] of Object.entries(LEGACY)) {
      const stored = ssm.params.get(`/sikrets/shop/${k}`)!;
      expect(envelopeKind(stored)).toBe("sealed");
      expect(stored).not.toContain(v);
    }
    expect(ssm.params.get("/sikrets/blog/OTHER_PROJECT")).toBe("left alone");
    const vault = await ssmVault("shop", { client: ssm.client, requireSealed: true });
    expect((await vault.get("CACHE_REDIS_REST_TOKEN"))!.reveal()).toBe(LEGACY.CACHE_REDIS_REST_TOKEN);
  });

  test("is idempotent: a second run changes nothing", async () => {
    const { params, key } = await setup();
    await migrateEncrypt(params, key);
    const after = new Map(ssm.params);
    const puts = ssm.calls.length;
    const again = await migrateEncrypt(params, key);
    expect(again.sealed).toEqual([]);
    expect(again.already).toHaveLength(3);
    expect(ssm.calls.length).toBe(puts);
    expect(ssm.params).toEqual(after);
  });

  test("--dry-run reports the same plan and writes nothing", async () => {
    const { params, key } = await setup();
    const before = new Map(ssm.params);
    const result = await migrateEncrypt(params, key, { dryRun: true });
    expect(result.sealed).toHaveLength(3);
    expect(ssm.calls).toEqual([]);
    expect(ssm.params).toEqual(before);
  });

  test("finishes a half-done migration and leaves values it can't open untouched", async () => {
    const { params, key } = await setup();
    ssm.params.set("/sikrets/shop/CACHE_REDIS_REST_URL", sealValue(key, "/sikrets/shop/CACHE_REDIS_REST_URL", LEGACY.CACHE_REDIS_REST_URL));
    const foreign = sealValue(randomBytes(32), "/sikrets/shop/FOREIGN_KEY", "someone else's");
    ssm.params.set("/sikrets/shop/FOREIGN_KEY", foreign);
    const result = await migrateEncrypt(params, key);
    expect(result.sealed).toEqual(["ANTHROPIC_API_KEY", "CACHE_REDIS_REST_TOKEN"]);
    expect(result.already).toEqual(["CACHE_REDIS_REST_URL"]);
    expect(result.unreadable).toEqual(["FOREIGN_KEY"]);
    expect(ssm.params.get("/sikrets/shop/FOREIGN_KEY")).toBe(foreign);
  });

  test("an in-place overwrite keeps plaintext in history; --purge-history drops it", async () => {
    const { params, key } = await setup();
    const name = "/sikrets/shop/CACHE_REDIS_REST_TOKEN";
    await migrateEncrypt(params, key);
    expect(ssm.history.get(name)).toContain(LEGACY.CACHE_REDIS_REST_TOKEN);
    // Re-running with --purge-history recreates already-sealed parameters too.
    const purged = await migrateEncrypt(params, key, { purgeHistory: true });
    expect(purged.purged).toHaveLength(3);
    expect(ssm.history.get(name)).toHaveLength(1);
    expect(ssm.history.get(name)![0]).not.toContain(LEGACY.CACHE_REDIS_REST_TOKEN);
    expect((await (await ssmVault("shop", { client: ssm.client })).get("CACHE_REDIS_REST_TOKEN"))!.reveal()).toBe(LEGACY.CACHE_REDIS_REST_TOKEN);
  });

  test("--purge-history interrupted after the delete loses nothing, and the next run finishes", async () => {
    const { params, key } = await setup();
    const name = "/sikrets/shop/CACHE_REDIS_REST_TOKEN";
    // The put that recreates the parameter fails (a throttle, an IAM denial, a crash).
    ssm.failPutWhen((n) => {
      if (n === name) throw new Error("ThrottlingException");
    });
    await expect(migrateEncrypt(params, key, { purgeHistory: true })).rejects.toThrow("Throttling");
    expect(ssm.params.has(name)).toBe(false); // deleted...
    expect(envelopeKind(ssm.params.get(`${name}.sikrets-staged`)!)).toBe("sealed"); // ...but kept, sealed
    expect([...(await params.list()).keys()]).not.toContain("CACHE_REDIS_REST_TOKEN.sikrets-staged");

    ssm.failPutWhen(undefined);
    const result = await migrateEncrypt(params, key, { purgeHistory: true });
    expect(result.changed).toEqual([]);
    expect([...ssm.params.keys()].filter((n) => n.endsWith(".sikrets-staged"))).toEqual([]);
    expect((await (await ssmVault("shop", { client: ssm.client })).get("CACHE_REDIS_REST_TOKEN"))!.reveal()).toBe(LEGACY.CACHE_REDIS_REST_TOKEN);
  });

  test("a value rotated while the migration runs is kept, not overwritten with the old one", async () => {
    const { params, key } = await setup();
    const name = "/sikrets/shop/CACHE_REDIS_REST_TOKEN";
    const rotated = sealValue(key, name, "tok_rotated");
    // Someone rotates the key right after the migration listed the project.
    const racing = { ...params, list: async () => { const all = await params.list(); ssm.params.set(name, rotated); return all; } };
    for (const purgeHistory of [false, true]) {
      ssm.params.set(name, LEGACY.CACHE_REDIS_REST_TOKEN);
      const result = await migrateEncrypt(racing, key, { purgeHistory });
      expect(result.changed).toEqual(["CACHE_REDIS_REST_TOKEN"]);
      expect(result.sealed).not.toContain("CACHE_REDIS_REST_TOKEN");
      expect(ssm.params.get(name)).toBe(rotated);
    }
  });
});
