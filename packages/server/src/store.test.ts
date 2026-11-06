import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dynamoStore } from "./dynamo.ts";
import { sqliteStore } from "./sqlite.ts";
import type { DeviceRecord, SignIn, Store } from "./store.ts";
import { envelope } from "./testing/client.ts";
import { fakeDynamo } from "./testing/fake-dynamo.ts";
import { SQLITE } from "./constants.ts";

// One contract, every adapter: SQLite in memory, SQLite on disk, and DynamoDB against an in-memory
// fake (with tiny pages, so pagination is exercised). No real AWS is touched.

const adapters: [string, () => Promise<{ store: Store; cleanup?: () => Promise<void> }>][] = [
  ["sqlite (memory)", async () => ({ store: sqliteStore() })],
  [
    "sqlite (file)",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-server-store-"));
      return { store: sqliteStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
  ["dynamodb (fake)", async () => ({ store: dynamoStore(fakeDynamo({ pageSize: 2 }), "sikrets") })],
];

const device = (id: string, user: string, over: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id,
  user,
  name: id,
  kind: "software",
  hardwareBound: false,
  registeredAt: "2026-11-05T00:00:00.000Z",
  jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  ...over,
});

const signIn = (requestId: string, userCode: string): SignIn => ({ requestId, userCode, jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, jkt: "t", name: "mac", kind: "software", hardwareBound: false, expiresAt: Date.now() + 60_000 });

for (const [name, open] of adapters) {
  describe(`store contract: ${name}`, () => {
    let store: Store;
    let cleanup: (() => Promise<void>) | undefined;
    const fresh = async () => {
      ({ store, cleanup } = await open());
      return store;
    };
    afterEach(async () => {
      store?.close();
      await cleanup?.();
    });

    test("nonces are claimed once until they expire", async () => {
      const s = await fresh();
      expect(await s.claimNonce("n1", 100, 10)).toBe(true);
      expect(await s.claimNonce("n1", 100, 50)).toBe(false);
      expect(await s.claimNonce("n2", 100, 50)).toBe(true);
      // Past its expiry the nonce is forgotten (the proof's clock window refuses such old proofs anyway).
      expect(await s.claimNonce("n1", 300, 200)).toBe(true);
    });

    test("sign-ins: put, find by request id or code, approve, delete", async () => {
      const s = await fresh();
      await s.putSignIn(signIn("dar_1", "BCDF-GHJK"));
      expect((await s.getSignIn("dar_1"))?.userCode).toBe("BCDF-GHJK");
      const found = (await s.findSignInByCode("BCDF-GHJK"))!;
      expect(found.requestId).toBe("dar_1");
      await s.putSignIn({ ...found, approvedBy: "a@x" });
      expect((await s.getSignIn("dar_1"))?.approvedBy).toBe("a@x");
      await s.deleteSignIn("dar_1");
      expect(await s.getSignIn("dar_1")).toBeUndefined();
      expect(await s.findSignInByCode("BCDF-GHJK")).toBeUndefined();
      expect(await s.findSignInByCode("NOPE-NOPE")).toBeUndefined();
    });

    test("devices are listed per account and updated in place", async () => {
      const s = await fresh();
      for (const d of [device("dev_a", "alice"), device("dev_b", "alice"), device("dev_c", "alice"), device("dev_z", "bob")]) await s.putDevice(d);
      expect((await s.listDevices("alice")).map((d) => d.id)).toEqual(["dev_a", "dev_b", "dev_c"]);
      expect((await s.listDevices("bob")).map((d) => d.id)).toEqual(["dev_z"]);
      expect(await s.listDevices("carol")).toEqual([]);
      await s.putDevice(device("dev_a", "alice", { revokedAt: "2026-11-05T01:00:00.000Z" }));
      expect((await s.getDevice("dev_a"))?.revokedAt).toBe("2026-11-05T01:00:00.000Z");
      expect((await s.getDevice("dev_a"))?.jwk).toEqual({ kty: "EC", crv: "P-256", x: "x", y: "y" });
      expect(await s.getDevice("dev_nope")).toBeUndefined();
    });

    test("values are scoped by account, project and environment", async () => {
      const s = await fresh();
      const dev = { account: "alice", project: "shop", environment: "dev" };
      const sealed = envelope();
      for (const n of ["B_KEY", "A_KEY", "C_KEY"]) await s.putValue(dev, { name: n, value: sealed, updatedAt: "t1", updatedBy: "dev_a" });
      expect((await s.listValues(dev)).map((v) => v.name)).toEqual(["A_KEY", "B_KEY", "C_KEY"]);
      expect((await s.listValues(dev))[0]!.bytes).toBe(Buffer.byteLength(sealed));
      expect(await s.getValue(dev, "A_KEY")).toEqual({ name: "A_KEY", value: sealed, updatedAt: "t1", updatedBy: "dev_a" });
      for (const other of [{ ...dev, account: "bob" }, { ...dev, project: "blog" }, { ...dev, environment: "prod" }]) {
        expect(await s.listValues(other)).toEqual([]);
        expect(await s.getValue(other, "A_KEY")).toBeUndefined();
        expect(await s.deleteValue(other, "A_KEY")).toBe(false);
      }
      const replaced = envelope();
      await s.putValue(dev, { name: "A_KEY", value: replaced, updatedAt: "t2", updatedBy: "dev_b" });
      expect((await s.getValue(dev, "A_KEY"))?.value).toBe(replaced);
      expect(await s.deleteValue(dev, "A_KEY")).toBe(true);
      expect(await s.deleteValue(dev, "A_KEY")).toBe(false);
      expect((await s.listValues(dev)).map((v) => v.name)).toEqual(["B_KEY", "C_KEY"]);
    });

    test("audit is per account, newest first, limited", async () => {
      const s = await fresh();
      for (let i = 0; i < 5; i++) await s.appendAudit({ at: `2026-11-05T00:00:0${i}.000Z`, user: "alice", action: `a${i}`, outcome: "ok" });
      await s.appendAudit({ at: "2026-11-05T00:00:09.000Z", user: "bob", action: "b", outcome: "ok" });
      expect((await s.listAudit("alice", 3)).map((e) => e.action)).toEqual(["a4", "a3", "a2"]);
      expect((await s.listAudit("alice", 50)).length).toBe(5);
      expect((await s.listAudit("bob", 50)).map((e) => e.action)).toEqual(["b"]);
    });

    test("meta keeps the first value", async () => {
      const s = await fresh();
      expect(await s.ensureMeta("k", () => "first")).toBe("first");
      expect(await s.ensureMeta("k", () => "second")).toBe("first");
    });
  });
}

test("sqlite on disk: owner-only file that survives reopening", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-server-store-"));
  try {
    const first = sqliteStore(dir);
    const scope = { account: "alice", project: "shop", environment: "dev" };
    const sealed = envelope();
    await first.putValue(scope, { name: "A_KEY", value: sealed, updatedAt: "t", updatedBy: "d" });
    first.close();
    expect((await stat(path.join(dir, SQLITE.file))).mode & 0o777).toBe(0o600);
    const second = sqliteStore(dir);
    expect((await second.getValue(scope, "A_KEY"))?.value).toBe(sealed);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dynamodb: values are stored as ciphertext items", async () => {
  const fake = fakeDynamo();
  const s = dynamoStore(fake, "sikrets");
  const sealed = envelope();
  await s.putValue({ account: "alice", project: "shop", environment: "dev" }, { name: "A_KEY", value: sealed, updatedAt: "t", updatedBy: "d" });
  const item = [...fake.items.values()].find((i) => i.sk?.S === "VALUE#A_KEY")!;
  expect(item.pk!.S).toBe("VAULT#alice#shop#dev");
  expect(JSON.parse(item.data!.S!).value).toBe(sealed);
});
