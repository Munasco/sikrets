import { describe, expect, spyOn, test } from "bun:test";
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

// A value sealed by the CLI (packages/cli core/envelope.ts) for project "shop", with a test data key
// of 32 bytes of 0x07. Fixed here so the SDK is checked against the CLI's exact format.
const VECTOR = {
  dataKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  projectKey: "sWk4+fZ3YRVSRKKXZ5gxnVznc7J/NAHm2lld4NdLF/M=",
  sealed: "sk1:9OvtWBxtiH/By46uyV5VeUYM5OA0onjCn1nkL7yIM77Ox1XyU9ny",
};

describe("encrypted values", () => {
  const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof SikretsError ? e.code : "other"));

  test("opens a CLI-sealed value with SIKRETS_PROJECT_KEY", async () => {
    const s = createSikrets({ env: { SIKRETS_PROJECT_KEY: VECTOR.projectKey }, project: "shop", fetch: fakeVault({ ANTHROPIC_API_KEY: VECTOR.sealed }).fetch });
    expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-ant-real");
  });

  test("derives the same project key from the data key in the Bun keychain", async () => {
    const get = spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => (service === "dev.sikrets.datakey" && name === "default" ? VECTOR.dataKey : null));
    try {
      const s = createSikrets({ env: {}, project: "shop", fetch: fakeVault({ ANTHROPIC_API_KEY: VECTOR.sealed }).fetch });
      expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-ant-real");
    } finally {
      get.mockRestore();
    }
  });

  test("a wrong key, another project or a moved value fails with code decrypt, never the value", async () => {
    const wrongKey = createSikrets({ projectKey: new Uint8Array(32), env: {}, project: "shop", fetch: fakeVault({ ANTHROPIC_API_KEY: VECTOR.sealed }).fetch });
    expect(await codeOf(wrongKey.get("ANTHROPIC_API_KEY"))).toBe("decrypt");
    const moved = createSikrets({ projectKey: VECTOR.projectKey, env: {}, project: "shop", fetch: fakeVault({ OTHER_KEY: VECTOR.sealed }).fetch });
    const err = await moved.get("OTHER_KEY").catch((e: Error) => e);
    expect((err as SikretsError).code).toBe("decrypt");
    expect(String(err)).not.toContain("sk-ant-real");
  });

  test("without any key, a sealed value explains how to get one", async () => {
    const get = spyOn(Bun.secrets, "get").mockImplementation(async () => null);
    try {
      const s = createSikrets({ env: {}, project: "shop", fetch: fakeVault({ ANTHROPIC_API_KEY: VECTOR.sealed }).fetch });
      expect(String(await s.get("ANTHROPIC_API_KEY").catch((e: Error) => e))).toContain("SIKRETS_PROJECT_KEY");
    } finally {
      get.mockRestore();
    }
  });

  test("legacy plaintext passes through, unless encryption is required", async () => {
    const v = fakeVault({ ANTHROPIC_API_KEY: "sk-ant-legacy" });
    expect(await createSikrets({ env: {}, project: "shop", fetch: v.fetch }).get("ANTHROPIC_API_KEY")).toBe("sk-ant-legacy");
    expect(await codeOf(createSikrets({ env: {}, project: "shop", fetch: v.fetch, requireEncrypted: true }).get("ANTHROPIC_API_KEY"))).toBe("decrypt");
  });

  test("follows sikrets.json: a project the CLI marked \"encryption\": \"required\" refuses plaintext here too", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(`${(await import("node:os")).tmpdir()}/sikrets-sdk-`);
    try {
      const v = fakeVault({ ANTHROPIC_API_KEY: "sk-ant-planted" });
      expect(await createSikrets({ env: {}, project: "shop", fetch: v.fetch, root }).get("ANTHROPIC_API_KEY")).toBe("sk-ant-planted");
      await writeFile(`${root}/sikrets.json`, JSON.stringify({ project: "shop", encryption: "required" }));
      expect(await codeOf(createSikrets({ env: {}, project: "shop", fetch: v.fetch, root }).get("ANTHROPIC_API_KEY"))).toBe("decrypt");
      // An explicit option still wins.
      expect(await createSikrets({ env: {}, project: "shop", fetch: v.fetch, root, requireEncrypted: false }).get("ANTHROPIC_API_KEY")).toBe("sk-ant-planted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
