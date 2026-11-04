import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackupError, openBackup, parseBackup, planRestore, prune, sealBackup, type BackupPayload } from "./core/backup.ts";
import { BACKUP } from "./constants.ts";

// Backups are pure data in, data out; no keychain, vault or network is involved here.
const payload: BackupPayload = {
  project: "shop",
  values: { CACHE_REDIS_REST_TOKEN: "tok_live_secret_value", SIKRETS_STANDIN__CACHE_REDIS_REST_TOKEN: "sk-sikrets-AAAAbbbbCCCCddddEEEEffffGGGGhhhh" },
  resources: [],
  connections: [{ provider: "upstash", account: "dev@example.com", mode: "terminal", connectedAt: "2026-11-01T00:00:00.000Z" }],
  logins: [{ provider: "upstash", account: "dev@example.com#api-key", value: "upstash-management-key" }],
};
const PASS = "correct horse battery staple";
const SECRETS = [...Object.values(payload.values), payload.logins[0]!.value];

let dir: string;
beforeEach(async () => void (dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-backup-"))));
afterEach(async () => rm(dir, { recursive: true, force: true }));

/** Writes and re-reads the file, as create then restore would. */
const roundTrip = async (file: object) => parseBackup(JSON.stringify(file));

describe("backup", () => {
  test("data-key mode round-trips and the file holds no secret in the clear", async () => {
    const dataKey = randomBytes(32);
    const file = await sealBackup(payload, { dataKey });
    const text = JSON.stringify(file);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain(dataKey.toString("base64"));
    expect(await openBackup(await roundTrip(file), { dataKey })).toEqual(payload);
  });

  test("passphrase mode uses Argon2id, round-trips, and needs no data key", async () => {
    const file = await sealBackup(payload, { passphrase: PASS });
    expect(file.mode).toBe("passphrase");
    expect(file.kdf!.name).toBe("argon2id");
    expect(JSON.stringify(file)).not.toContain(PASS);
    expect(await openBackup(await roundTrip(file), { passphrase: PASS })).toEqual(payload);
  });

  test("a wrong passphrase or another data key is refused cleanly", async () => {
    const byPass = await sealBackup(payload, { passphrase: PASS });
    await expect(openBackup(byPass, { passphrase: "not the right passphrase" })).rejects.toThrow("Wrong passphrase");
    await expect(openBackup(byPass, { dataKey: randomBytes(32) })).rejects.toThrow("sealed with a passphrase");
    const byKey = await sealBackup(payload, { dataKey: randomBytes(32) });
    await expect(openBackup(byKey, { dataKey: randomBytes(32) })).rejects.toThrow("different data key");
    await expect(sealBackup(payload, { passphrase: "short" })).rejects.toThrow(`at least ${BACKUP.minPassphrase}`);
  });

  test("a corrupt or edited file is caught, and errors never contain values", async () => {
    const dataKey = randomBytes(32);
    const file = await sealBackup(payload, { dataKey });
    const ct = Buffer.from(file.sealed.ct, "base64");
    ct[10]! ^= 1;
    const flipped = { ...file, sealed: { ...file.sealed, ct: ct.toString("base64") } };
    const err = await openBackup(flipped, { dataKey }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as Error).message).toContain("changed or corrupted");
    for (const s of SECRETS) expect((err as Error).message).not.toContain(s);
    // The readable header is bound in: retargeting it to another project breaks the box.
    await expect(openBackup({ ...file, project: "blog" }, { dataKey })).rejects.toThrow("changed or corrupted");
    await expect(openBackup({ ...file, createdAt: "2020-01-01T00:00:00.000Z" }, { dataKey })).rejects.toThrow(BackupError);

    const text = JSON.stringify(file);
    expect(() => parseBackup(text.slice(0, text.length / 2))).toThrow("isn't a Sikrets backup");
    expect(() => parseBackup(JSON.stringify({ hello: "world" }))).toThrow("isn't a Sikrets backup");
    expect(() => parseBackup(JSON.stringify({ ...file, sealed: { iv: file.sealed.iv } }))).toThrow("corrupt");
    expect(() => parseBackup(JSON.stringify({ ...file, version: 99 }))).toThrow("isn't supported");
  });

  test("restore plans by name: new, changed and unchanged", () => {
    const current = new Map([["CACHE_REDIS_REST_TOKEN", "tok_older_value"], ["SIKRETS_STANDIN__CACHE_REDIS_REST_TOKEN", payload.values.SIKRETS_STANDIN__CACHE_REDIS_REST_TOKEN!]]);
    expect(planRestore(payload, current)).toEqual({ add: [], replace: ["CACHE_REDIS_REST_TOKEN"], same: ["SIKRETS_STANDIN__CACHE_REDIS_REST_TOKEN"] });
    expect(planRestore(payload, new Map()).add).toHaveLength(2);
  });

  test("--dir keeps the newest N of this project's backups and nothing else", async () => {
    const names = [1, 2, 3, 4].map((d) => BACKUP.fileName("shop", new Date(Date.UTC(2026, 10, d))));
    for (const n of [...names, BACKUP.fileName("shop-api", new Date(0)), "notes.txt"]) await Bun.write(path.join(dir, n), "x");
    expect(await prune(dir, "shop", 2)).toEqual(names.slice(0, 2));
    expect((await readdir(dir)).sort()).toEqual([...names.slice(2), BACKUP.fileName("shop-api", new Date(0)), "notes.txt"].sort());
  });
});
