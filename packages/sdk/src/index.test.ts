import { describe, expect, test } from "bun:test";
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
