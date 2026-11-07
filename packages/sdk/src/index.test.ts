import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_ENV, DATA_KEY, ENVELOPE } from "./constants.ts";
import { createSikrets, SikretsError } from "./index.ts";

const STAND_IN = "sk-sikrets-AAAAbbbbCCCCddddEEEEffffGGGGhhhh";

function fakeVault(values: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (project: string, key: string) => {
      calls.push(`${project}/${key}`);
      await Bun.sleep(1);
      return values[key];
    },
  };
}

describe("sikrets.get", () => {
  test("a real value already in the environment is returned without touching the vault", async () => {
    const v = fakeVault({});
    const s = createSikrets({ env: { ANTHROPIC_API_KEY: "sk-ant-real" }, project: "demo", fetch: v.fetch });
    expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-ant-real");
    expect(v.calls).toHaveLength(0);
  });

  test("a stand-in is resolved to the real value from the project's vault", async () => {
    const v = fakeVault({ ANTHROPIC_API_KEY: "sk-ant-real" });
    const s = createSikrets({ env: { ANTHROPIC_API_KEY: STAND_IN }, project: "demo", fetch: v.fetch });
    expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-ant-real");
    expect(v.calls).toEqual(["demo/ANTHROPIC_API_KEY"]);
  });

  test("a missing env var is looked up too, using SIKRETS_PROJECT", async () => {
    const v = fakeVault({ CACHE_REDIS_REST_TOKEN: "tok" });
    const s = createSikrets({ env: { SIKRETS_PROJECT: "shop" }, fetch: v.fetch });
    expect(await s.get("CACHE_REDIS_REST_TOKEN")).toBe("tok");
    expect(v.calls).toEqual(["shop/CACHE_REDIS_REST_TOKEN"]);
  });

  test("values are cached, then refetched after the TTL so rotations are picked up", async () => {
    let t = 0;
    const values = { KEY_A: "v1" };
    const v = fakeVault(values);
    const s = createSikrets({ env: {}, project: "demo", fetch: v.fetch, ttlMs: 1000, now: () => t });
    expect(await s.get("KEY_A")).toBe("v1");
    values.KEY_A = "v2"; // rotated in the vault
    expect(await s.get("KEY_A")).toBe("v1");
    t = 1001;
    expect(await s.get("KEY_A")).toBe("v2");
    expect(v.calls).toHaveLength(2);
  });

  test("concurrent requests for one key share a single vault call", async () => {
    const v = fakeVault({ KEY_A: "v" });
    const s = createSikrets({ env: {}, project: "demo", fetch: v.fetch });
    expect(await Promise.all([s.get("KEY_A"), s.get("KEY_A"), s.get("KEY_A")])).toEqual(["v", "v", "v"]);
    expect(v.calls).toHaveLength(1);
  });

  test("getAll returns a typed record", async () => {
    const s = createSikrets({ env: { A_KEY: "a" }, project: "demo", fetch: fakeVault({ B_KEY: "b" }).fetch });
    expect(await s.getAll(["A_KEY", "B_KEY"])).toEqual({ A_KEY: "a", B_KEY: "b" });
  });
});

describe("errors", () => {
  const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof SikretsError ? e.code : "other"));

  test("missing keys, bad names and vault failures have distinct codes", async () => {
    const s = createSikrets({ env: {}, project: "demo", fetch: fakeVault({}).fetch });
    expect(await codeOf(s.get("NOPE"))).toBe("not-found");
    expect(await codeOf(s.get("lower-case"))).toBe("invalid-key");
    const broken = createSikrets({ env: {}, project: "demo", fetch: async () => Promise.reject(new Error("AccessDenied")) });
    expect(await codeOf(broken.get("KEY_A"))).toBe("vault");
  });

  test("never hands back a stand-in, even if the vault holds one", async () => {
    const s = createSikrets({ env: {}, project: "demo", fetch: fakeVault({ KEY_A: STAND_IN }).fetch });
    expect(await codeOf(s.get("KEY_A"))).toBe("vault");
  });

  test("error messages never include values", async () => {
    const s = createSikrets({ env: { KEY_A: STAND_IN }, project: "demo", fetch: fakeVault({}).fetch });
    const err = await s.get("KEY_A").catch((e: Error) => e);
    expect(String(err)).not.toContain(STAND_IN);
  });
});

describe("client-side encryption", () => {
  const dataKey = randomBytes(32);
  const REAL = ["tok", "live", "fake"].join("_");
  // Sealed the way the CLI seals (packages/cli/src/core/envelope.ts).
  function sealed(project: string, key: string, value: string) {
    const k = Buffer.from(hkdfSync("sha256", dataKey, ENVELOPE.hkdfSalt, ENVELOPE.hkdfInfo(project), 32));
    const iv = randomBytes(ENVELOPE.ivBytes);
    const c = createCipheriv("aes-256-gcm", k, iv).setAAD(Buffer.from(ENVELOPE.aad(project, key)));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return ENVELOPE.prefix + Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64");
  }
  const keychain = (entries: Record<string, string>) =>
    spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => entries[`${service}/${name}`] ?? null);

  // An empty config dir, so the device-wrapped key in the real ~/.sikrets is never read.
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-sdk-"));
    process.env[CONFIG_DIR_ENV] = dir;
  });
  afterEach(async () => {
    mock.restore();
    delete process.env[CONFIG_DIR_ENV];
    await rm(dir, { recursive: true, force: true });
  });

  test("a sealed keychain value is opened with the user's data key", async () => {
    keychain({ [`${DATA_KEY.service}/${DATA_KEY.name}`]: dataKey.toString("base64"), "dev.sikrets.vault.demo/API_KEY": sealed("demo", "API_KEY", REAL) });
    expect(await createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("API_KEY")).toBe(REAL);
  });

  test("a value moved to another key fails, and nothing sealed is ever returned as the value", async () => {
    keychain({ [`${DATA_KEY.service}/${DATA_KEY.name}`]: dataKey.toString("base64"), "dev.sikrets.vault.demo/OTHER_KEY": sealed("demo", "API_KEY", REAL) });
    await expect(createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("OTHER_KEY")).rejects.toThrow("can't decrypt");
  });

  test("without a data key the error says so", async () => {
    keychain({ "dev.sikrets.vault.demo/API_KEY": sealed("demo", "API_KEY", REAL) });
    await expect(createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("API_KEY")).rejects.toThrow("SIKRETS_PROJECT_KEY");
  });
});
