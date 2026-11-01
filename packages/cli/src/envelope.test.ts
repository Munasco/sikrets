import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ensureDataKey, loadDataKey, saveDataKey } from "./core/datakey.ts";
import { EnvelopeError, envelopeKind, openValue, projectKey, sealValue } from "./core/envelope.ts";
import { Secret } from "./core/secret.ts";
import { ssmVault } from "./core/vault.ts";
import { fakeSsm } from "./fake-ssm.ts";

// In-memory keychain and Parameter Store, so nothing real is touched.
const keychain = new Map<string, string>();

beforeEach(() => {
  keychain.clear();
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
});

const NAME = "/sikrets/shop/CACHE_REDIS_REST_TOKEN";
const VALUE = "tok_live_secret_value";

describe("envelope", () => {
  test("round-trips, with a fresh IV each time and no plaintext in the output", () => {
    const key = randomBytes(32);
    const a = sealValue(key, NAME, VALUE);
    const b = sealValue(key, NAME, VALUE);
    expect(a.startsWith("sk1:")).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain(VALUE);
    expect(Buffer.from(a.slice(4), "base64").toString("latin1")).not.toContain(VALUE);
    expect(openValue(key, NAME, a)).toBe(VALUE);
    expect(openValue(key, NAME, sealValue(key, NAME, "ünïcode ✓"))).toBe("ünïcode ✓");
  });

  test("any tampering fails: IV, ciphertext, tag or truncation", () => {
    const key = randomBytes(32);
    const raw = Buffer.from(sealValue(key, NAME, VALUE).slice(4), "base64");
    for (const i of [0, 12, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[i]! ^= 1;
      expect(() => openValue(key, NAME, `sk1:${bad.toString("base64")}`)).toThrow(EnvelopeError);
    }
    expect(() => openValue(key, NAME, `sk1:${raw.subarray(0, 20).toString("base64")}`)).toThrow("corrupt");
  });

  test("a value moved to another name or project doesn't open (AAD)", () => {
    const key = randomBytes(32);
    const sealed = sealValue(key, NAME, VALUE);
    expect(() => openValue(key, "/sikrets/shop/OTHER_KEY", sealed)).toThrow("different data key, or changed");
    expect(() => openValue(key, "/sikrets/blog/CACHE_REDIS_REST_TOKEN", sealed)).toThrow(EnvelopeError);
  });

  test("a wrong key fails, and errors never contain the value", () => {
    const sealed = sealValue(randomBytes(32), NAME, VALUE);
    const err = (() => {
      try {
        openValue(randomBytes(32), NAME, sealed);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(EnvelopeError);
    expect(err!.message).toContain(NAME);
    expect(err!.message).not.toContain(VALUE);
  });

  test("legacy plaintext and newer versions are told apart", () => {
    expect(envelopeKind("tok_live_secret_value")).toBe("plain");
    expect(envelopeKind("sk-ant-api03-abc")).toBe("plain");
    expect(envelopeKind("sk1:AAAA")).toBe("sealed");
    expect(envelopeKind("sk2:AAAA")).toBe("newer");
    expect(() => openValue(randomBytes(32), NAME, "sk2:AAAA")).toThrow("newer Sikrets");
  });

  test("project keys are stable per data key and differ per project", () => {
    const dk = randomBytes(32);
    expect(projectKey(dk, "shop").equals(projectKey(dk, "shop"))).toBe(true);
    expect(projectKey(dk, "shop").equals(projectKey(dk, "blog"))).toBe(false);
    expect(projectKey(dk, "shop").equals(dk)).toBe(false);
  });
});

describe("ssm vault", () => {
  test("seals on write and opens on read; SSM only ever sees the envelope", async () => {
    const ssm = fakeSsm();
    const vault = await ssmVault("shop", { client: ssm.client });
    await vault.put("CACHE_REDIS_REST_TOKEN", Secret.of(VALUE));
    const stored = ssm.params.get(NAME)!;
    expect(stored.startsWith("sk1:")).toBe(true);
    expect(stored).not.toContain(VALUE);
    expect((await vault.get("CACHE_REDIS_REST_TOKEN"))!.reveal()).toBe(VALUE);
    expect(await vault.get("MISSING_KEY")).toBeUndefined();
    // The first write created this device's data key.
    expect(await loadDataKey()).toBeDefined();
  });

  test("reads legacy plaintext until migrated, unless the project requires encryption", async () => {
    const ssm = fakeSsm();
    ssm.params.set(NAME, VALUE);
    await ensureDataKey();
    expect((await (await ssmVault("shop", { client: ssm.client })).get("CACHE_REDIS_REST_TOKEN"))!.reveal()).toBe(VALUE);
    const strict = await ssmVault("shop", { client: ssm.client, requireSealed: true });
    await expect(strict.get("CACHE_REDIS_REST_TOKEN")).rejects.toThrow("stored unencrypted");
  });

  test("a sealed value copied onto another parameter doesn't open", async () => {
    const ssm = fakeSsm();
    const vault = await ssmVault("shop", { client: ssm.client });
    await vault.put("CACHE_REDIS_REST_TOKEN", Secret.of(VALUE));
    ssm.params.set("/sikrets/shop/OTHER_KEY", ssm.params.get(NAME)!);
    await expect(vault.get("OTHER_KEY")).rejects.toThrow(EnvelopeError);
  });

  test("a second device without the data key is told to restore, and never mints a rival key", async () => {
    const ssm = fakeSsm();
    await (await ssmVault("shop", { client: ssm.client })).put("CACHE_REDIS_REST_TOKEN", Secret.of(VALUE));
    const original = (await loadDataKey())!;

    keychain.clear(); // a new laptop
    const vault = await ssmVault("shop", { client: ssm.client });
    await expect(vault.get("CACHE_REDIS_REST_TOKEN")).rejects.toThrow("sikrets recovery restore");
    await expect(vault.put("NEW_KEY", Secret.of("x"))).rejects.toThrow("sikrets recovery restore");
    expect(await loadDataKey()).toBeUndefined();

    await saveDataKey(original); // what `sikrets recovery restore` does
    expect((await (await ssmVault("shop", { client: ssm.client })).get("CACHE_REDIS_REST_TOKEN"))!.reveal()).toBe(VALUE);
  });
});
