import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceRecord, SignIn, Store } from "./store.ts";
import { envelope } from "./testing/client.ts";

// The storage contract every adapter must pass, as a bun:test suite. Call it from a test file
// with a function that opens a fresh, empty store (and optionally a cleanup):
//
//   import { storeContract } from "@sikrets/server/store-contract";
//   storeContract("postgres", async () => ({ store: await postgresStore(url), cleanup: dropSchema }));

export type OpenStore = () => Promise<{ store: Store; cleanup?: () => Promise<void> }>;

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

const NOW = Date.parse("2026-11-05T00:00:00.000Z");
const signIn = (requestId: string, userCode: string, over: Partial<SignIn> = {}): SignIn => ({ requestId, userCode, jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, jkt: "t", name: "mac", kind: "software", hardwareBound: false, expiresAt: NOW + 60_000, status: "pending", ...over });

export function storeContract(name: string, open: OpenStore) {
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

    test("sign-ins: create, find by request id or code, approve once, collect once", async () => {
      const s = await fresh();
      await s.createSignIn(signIn("dar_1", "BCDF-GHJK"), NOW);
      expect(await s.getSignIn("dar_1")).toMatchObject({ userCode: "BCDF-GHJK", status: "pending" });
      expect((await s.findSignInByCode("BCDF-GHJK"))?.requestId).toBe("dar_1");
      expect(await s.findSignInByCode("NOPE-NOPE")).toBeUndefined();
      expect(await s.collectSignIn("dar_1", NOW)).toBeUndefined(); // not approved yet
      expect(await s.approveSignIn("dar_1", "a@x", NOW)).toMatchObject({ status: "approved", approvedBy: "a@x" });
      expect(await s.approveSignIn("dar_1", "mallory@x", NOW)).toBeUndefined(); // already approved: no account switch
      expect((await s.getSignIn("dar_1"))?.approvedBy).toBe("a@x");
      expect(await s.collectSignIn("dar_1", NOW)).toMatchObject({ approvedBy: "a@x" });
      expect(await s.collectSignIn("dar_1", NOW)).toBeUndefined();
      expect(await s.approveSignIn("dar_1", "a@x", NOW)).toBeUndefined(); // a collected sign-in never comes back
      expect((await s.getSignIn("dar_1"))?.status).toBe("collected");
    });

    test("sign-ins: concurrent approvals and collects each win exactly once", async () => {
      const s = await fresh();
      await s.createSignIn(signIn("dar_2", "CDFG-HJKL"), NOW);
      const approvals = await Promise.all(["a@x", "b@x", "c@x", "d@x"].map((u) => s.approveSignIn("dar_2", u, NOW)));
      expect(approvals.filter(Boolean)).toHaveLength(1);
      expect((await s.getSignIn("dar_2"))?.approvedBy).toBe(approvals.find(Boolean)!.approvedBy);
      const collects = await Promise.all([1, 2, 3, 4].map(() => s.collectSignIn("dar_2", NOW)));
      expect(collects.filter(Boolean)).toHaveLength(1);
    });

    test("sign-ins: deny, expire, and nothing after expiry", async () => {
      const s = await fresh();
      await s.createSignIn(signIn("dar_3", "DFGH-JKLM"), NOW);
      expect(await s.denySignIn("dar_3")).toBe(true);
      expect(await s.denySignIn("dar_3")).toBe(false);
      expect(await s.approveSignIn("dar_3", "a@x", NOW)).toBeUndefined();
      await s.createSignIn(signIn("dar_4", "FGHJ-KLMN"), NOW);
      expect(await s.approveSignIn("dar_4", "a@x", NOW + 61_000)).toBeUndefined(); // past expiry
      await s.expireSignIn("dar_4", NOW + 61_000);
      expect((await s.getSignIn("dar_4"))?.status).toBe("expired");
      await s.createSignIn(signIn("dar_5", "GHJK-LMNP", { status: "approved", approvedBy: "a@x" }), NOW);
      expect(await s.collectSignIn("dar_5", NOW + 61_000)).toBeUndefined();
    });

    test("devices: listed per account; lastSeenAt never undoes a revoke; revoked stays revoked", async () => {
      const s = await fresh();
      for (const d of [device("dev_a", "alice"), device("dev_b", "alice"), device("dev_c", "alice"), device("dev_z", "bob")]) await s.createDevice(d);
      await expect(s.createDevice(device("dev_a", "alice"))).rejects.toThrow();
      expect((await s.listDevices("alice")).map((d) => d.id)).toEqual(["dev_a", "dev_b", "dev_c"]);
      expect((await s.listDevices("bob")).map((d) => d.id)).toEqual(["dev_z"]);
      expect(await s.listDevices("carol")).toEqual([]);
      expect(await s.touchDevice("dev_a", "2026-11-05T00:30:00.000Z")).toBe(true);
      expect((await s.getDevice("dev_a"))?.lastSeenAt).toBe("2026-11-05T00:30:00.000Z");
      // A request that loaded dev_a before the revoke finishes after it: its touch must not bring it back.
      const [revoked, touched] = await Promise.all([s.revokeDevice("dev_a", "2026-11-05T01:00:00.000Z"), s.touchDevice("dev_a", "2026-11-05T01:00:01.000Z")]);
      expect(revoked).toBe(true);
      expect(await s.touchDevice("dev_a", "2026-11-05T01:00:02.000Z")).toBe(false);
      expect((await s.getDevice("dev_a"))?.revokedAt).toBe("2026-11-05T01:00:00.000Z");
      expect(touched === false || (await s.getDevice("dev_a"))?.revokedAt !== undefined).toBe(true);
      expect(await s.revokeDevice("dev_a", "2026-11-05T02:00:00.000Z")).toBe(false); // revokedAt is never rewritten
      expect((await s.getDevice("dev_a"))?.revokedAt).toBe("2026-11-05T01:00:00.000Z");
      expect((await s.listDevices("alice")).find((d) => d.id === "dev_a")?.revokedAt).toBe("2026-11-05T01:00:00.000Z");
      expect((await s.getDevice("dev_a"))?.jwk).toEqual({ kty: "EC", crv: "P-256", x: "x", y: "y" });
      expect(await s.getDevice("dev_nope")).toBeUndefined();
      expect(await s.touchDevice("dev_nope", "t")).toBe(false);
      expect(await s.revokeDevice("dev_nope", "t")).toBe(false);
    });

    test("revoked keys are remembered", async () => {
      const s = await fresh();
      expect(await s.isKeyRevoked("jkt_1")).toBe(false);
      await s.revokeKey("jkt_1", "2026-11-05T00:00:00.000Z");
      await s.revokeKey("jkt_1", "2026-11-05T00:00:01.000Z");
      expect(await s.isKeyRevoked("jkt_1")).toBe(true);
      expect(await s.isKeyRevoked("jkt_2")).toBe(false);
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
      expect(await s.createValue(dev, { name: "A_KEY", value: sealed, updatedAt: "t3", updatedBy: "dev_c" })).toBe(false); // create-only never overwrites
      expect((await s.getValue(dev, "A_KEY"))?.value).toBe(replaced);
      expect(await s.createValue(dev, { name: "D_KEY", value: sealed, updatedAt: "t3", updatedBy: "dev_c" })).toBe(true);
      expect(await s.deleteValue(dev, "D_KEY")).toBe(true);
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
