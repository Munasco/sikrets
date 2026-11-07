import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDataKey, fingerprint, loadDataKey, open, saveDataKey, seal } from "./core/datakey.ts";
import { createRecord, decodeCode, deriveKey, encodeCode, markUsed, newCode, readRecord, recordState, recoveryFile, replaceRecord, secretFrom, unwrap, wrap, writeRecord, WrongCodeError } from "./core/recovery.ts";
import { recoveryStatus } from "./commands/recovery.ts";
import { combine, split } from "./core/shamir.ts";

// In-memory keychain and a throwaway config dir, so nothing real is touched.
const keychain = new Map<string, string>();
let dir: string;

beforeEach(async () => {
  keychain.clear();
  dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-recovery-"));
  process.env.SIKRETS_CONFIG_DIR = dir;
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
});

afterEach(async () => {
  delete process.env.SIKRETS_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("data key", () => {
  test("is created once, kept in the keychain, and seals values", async () => {
    const key = await ensureDataKey();
    expect(key.length).toBe(32);
    expect((await ensureDataKey()).equals(key)).toBe(true);
    expect([...keychain.keys()]).toEqual(["dev.sikrets.datakey/default"]);
    const sealed = seal(key, Buffer.from("hello"), "ctx");
    expect(open(key, sealed, "ctx").toString()).toBe("hello");
    expect(() => open(key, sealed, "other ctx")).toThrow();
  });
});

describe("recovery codes", () => {
  test("round-trip, tolerate formatting, and catch typos", () => {
    const { secret, shown } = newCode();
    const code = shown[0]!;
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(decodeCode(code)).toEqual(new Uint8Array(secret));
    expect(decodeCode(code.toLowerCase().replace(/-/g, " "))).toEqual(new Uint8Array(secret));
    const typo = code.slice(0, 2) + (code[2] === "A" ? "B" : "A") + code.slice(3);
    expect(() => decodeCode(typo)).toThrow("typo");
    expect(() => decodeCode("ABCD-EFGH")).toThrow("groups");
  });

  test("Shamir 2-of-3: any two shares rebuild the code, one doesn't", () => {
    const { secret, shown } = newCode({ split: true });
    expect(shown).toHaveLength(3);
    for (const pair of [[0, 1], [0, 2], [1, 2]] as const) {
      expect(secretFrom([shown[pair[0]]!, shown[pair[1]]!])).toEqual(new Uint8Array(secret));
    }
    expect(() => secretFrom([shown[0]!])).toThrow("2 different recovery shares");
    expect(() => secretFrom([shown[1]!, shown[1]!])).toThrow("same share");
    const raw = split(new Uint8Array([0, 1, 255, 128]), 3, 2);
    expect(combine([raw[2]!, raw[0]!])).toEqual(new Uint8Array([0, 1, 255, 128]));
  });
});

describe("wrap and restore", () => {
  test("KDF is Argon2id, deterministic per salt, and the wrap round-trips", async () => {
    const dataKey = await ensureDataKey();
    const { secret } = newCode();
    const record = await wrap(dataKey, secret);
    expect(record.kdf.name).toBe("argon2id");
    expect((await deriveKey(secret, record.kdf)).equals(await deriveKey(secret, record.kdf))).toBe(true);
    expect((await unwrap(record, secret)).equals(dataKey)).toBe(true);
    // Only the wrapped key is stored: neither the data key nor the code appear in the record.
    const json = JSON.stringify(record);
    expect(json).not.toContain(dataKey.toString("base64"));
    expect(json).not.toContain(encodeCode(secret).replace(/-/g, ""));
  });

  test("a wrong code fails cleanly and changes nothing", async () => {
    const dataKey = await ensureDataKey();
    const record = await wrap(dataKey, newCode().secret);
    await expect(unwrap(record, newCode().secret)).rejects.toBeInstanceOf(WrongCodeError);
    // Tampering with the record's binding fails the same way.
    await expect(unwrap({ ...record, id: "rk_other" }, newCode().secret)).rejects.toBeInstanceOf(WrongCodeError);
  });

  test("restores the data key on a fresh device from a kept record", async () => {
    const dataKey = await ensureDataKey();
    const { secret, shown } = newCode({ split: true });
    await writeRecord(await wrap(dataKey, secret, { split: true }));
    expect((await stat(recoveryFile())).mode & 0o777).toBe(0o600);

    keychain.clear(); // the laptop is gone
    expect(await loadDataKey()).toBeUndefined();
    const record = (await readRecord())!;
    await saveDataKey(await unwrap(record, secretFrom([shown[2]!, shown[0]!])));
    expect(fingerprint((await loadDataKey())!)).toBe(fingerprint(dataKey));
  });

  test("rotate invalidates the old code", async () => {
    const dataKey = await ensureDataKey();
    const oldCode = newCode().secret;
    const first = await wrap(dataKey, oldCode);
    await writeRecord(first);

    const newer = newCode().secret;
    await writeRecord(await wrap(dataKey, newer));
    const current = (await readRecord())!;
    expect(current.id).not.toBe(first.id);
    await expect(unwrap(current, oldCode)).rejects.toBeInstanceOf(WrongCodeError);
    expect((await unwrap(current, newer)).equals(dataKey)).toBe(true);
  });
});

describe("recovery record lifecycle", () => {
  test("two first-time setups at once: one wins, the other changes nothing", async () => {
    const dataKey = await ensureDataKey();
    const [a, b] = [await wrap(dataKey, newCode().secret), await wrap(dataKey, newCode().secret)];
    const results = await Promise.allSettled([createRecord(a), createRecord(b)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect((await readRecord())!.id).toBe(winner.id);
    expect((await stat(recoveryFile())).mode & 0o777).toBe(0o600);
  });

  test("rotate refuses to replace a record that changed after it was read", async () => {
    const dataKey = await ensureDataKey();
    const first = await wrap(dataKey, newCode().secret);
    await createRecord(first);
    await replaceRecord(await wrap(dataKey, newCode().secret), first.id); // another run rotated
    await expect(replaceRecord(await wrap(dataKey, newCode().secret), first.id)).rejects.toThrow("changed");
  });

  test("a restore marks the code used; status then asks for a new one", async () => {
    const dataKey = await ensureDataKey();
    const record = await wrap(dataKey, newCode().secret);
    await createRecord(record);
    expect(recoveryStatus(record, dataKey)).toBe("ok");
    await markUsed(record.id);
    const used = (await readRecord())!;
    expect(recordState(used)).toBe("used");
    expect(used.usedAt).toBeString();
    expect(recoveryStatus(used, dataKey)).toBe("used");
    expect(recoveryStatus(used, undefined)).toBe("no key on this device");
    expect(recoveryStatus(used, Buffer.alloc(32, 7))).toBe("mismatch");
    expect(recoveryStatus(undefined, dataKey)).toBe("not set up");
  });

  test("first use on two processes at once makes one data key, not two", async () => {
    const keys = await Promise.all([ensureDataKey(), ensureDataKey(), ensureDataKey()]);
    expect(new Set(keys.map((k) => k.toString("hex"))).size).toBe(1);
  });
});
