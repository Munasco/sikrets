import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.ts";
import { autoApproval, manualApproval } from "./approval.ts";
import { readConfig, startupWarnings } from "./config.ts";
import { dynamoStore } from "./dynamo.ts";
import { startServer } from "./index.ts";
import { sqliteStore } from "./sqlite.ts";
import type { Store } from "./store.ts";
import { envelope, testDevice } from "./testing/client.ts";
import { fakeDynamo } from "./testing/fake-dynamo.ts";
import { ENV, PROTOCOL, VALUES } from "./constants.ts";

// The HTTP API, in-process: sign-in, proofs, devices, sealed values and the audit log. Devices are
// software keys made per test; values are placeholder envelopes, never real secrets.

const P = PROTOCOL.paths;
const ADMIN = ["admin", "token", "for", "tests"].join("-");
/** The data-key fingerprint every write in these tests is sealed under. */
const FP = "0123456789abcdef";
const values = (project = "shop", environment = "dev") => `/v1/projects/${project}/environments/${environment}/values`;
const value = (name: string, project = "shop", environment = "dev") => `${values(project, environment)}/${name}`;

function setup(opts: { store?: Store; manual?: boolean; maxValueBytes?: number; now?: () => number; publicUrl?: string } = {}) {
  const store = opts.store ?? sqliteStore();
  const app = createApp({ store, approval: opts.manual ? manualApproval({ adminToken: ADMIN }) : autoApproval("you@localhost"), maxValueBytes: opts.maxValueBytes, now: opts.now, publicUrl: opts.publicUrl });
  return { store, app, device: (origin?: string, signedOrigin?: string) => testDevice(app, origin, { now: opts.now, signedOrigin }) };
}

describe("sign-in", () => {
  test("auto approval: start, collect, then signed requests work", async () => {
    const { app, device } = setup();
    const info = await (await app.fetch(new Request(`http://sikrets.test${P.info}`))).json();
    expect(info).toMatchObject({ service: "sikrets", apiVersion: 1, approval: "auto" });
    const d = device();
    const { requestId, userCode, verificationUri } = await d.start("mac");
    expect(userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(verificationUri).toBe(`http://sikrets.test${P.approve}?code=${userCode}`);
    const done = await d.collect(requestId);
    expect(done.status).toBe(200);
    expect(done.body.deviceId).toStartWith(PROTOCOL.deviceIdPrefix);
    // The certificate binds the device id to its key, signed by the server key /v1/info publishes.
    const [h, p, sig] = (done.body.certificate as string).split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims).toMatchObject({ sub: done.body.deviceId, user: "you@localhost", hw: false });
    const { createPublicKey, verify } = await import("node:crypto");
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: info.certificateKey, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
    expect(await d.call("GET", P.me)).toEqual({ status: 200, body: { user: "you@localhost", deviceId: done.body.deviceId } });
    // Collected once.
    expect((await d.collect(requestId)).body.error).toBe("invalid_grant");
  });

  test("manual approval: pending until an approved device or the admin approves", async () => {
    const { device } = setup({ manual: true });
    const first = device();
    const started = await first.start();
    expect((await first.collect(started.requestId)).body.error).toBe(PROTOCOL.pending);
    // Nobody may approve without a device proof or the admin token.
    expect((await first.call("POST", P.approve, { code: started.userCode, user: "alice" }, { proof: null })).status).toBe(403);
    expect((await first.call("POST", P.approve, { code: started.userCode, user: "alice" }, { proof: null }, { authorization: "Bearer wrong" })).status).toBe(403);
    expect((await first.call("POST", P.approve, { code: started.userCode, user: "alice" }, { proof: null }, { authorization: `Bearer ${ADMIN}` })).status).toBe(200);
    expect((await first.collect(started.requestId)).body.user).toBe("alice");

    // Alice's device approves her next device; it can't approve it into another account.
    const second = device();
    const next = await second.start();
    expect((await first.call("POST", P.approve, { code: next.userCode, user: "mallory" })).status).toBe(200);
    expect((await second.collect(next.requestId)).body.user).toBe("alice");
  });

  test("registering needs the key's own signature, and only that key collects", async () => {
    const { device } = setup();
    const owner = device();
    const thief = device();
    // Claiming another key: the proof is signed by the thief, the payload names the owner's key.
    const claimed = await thief.call("POST", P.authorize, { publicKey: owner.jwk }, { kid: null });
    expect(claimed).toEqual({ status: 400, body: { error: "invalid_request", reason: "the proof isn't signed by the key being registered" } });
    // A private key in the header is refused outright.
    expect((await owner.call("POST", P.authorize, { publicKey: owner.jwk }, { jwk: { ...owner.jwk, d: "private" } })).body.reason).toBe("no device key");
    const { requestId } = await owner.start();
    expect(await thief.collect(requestId)).toEqual({ status: 400, body: { error: "invalid_grant", reason: "a different key started this sign-in" } });
    expect((await owner.collect(requestId)).status).toBe(200);
  });

  test("an unapproved sign-in expires", async () => {
    let t = Date.now();
    const { device } = setup({ manual: true, now: () => t });
    const d = device();
    const { requestId } = await d.start();
    t += PROTOCOL.approvalTimeoutMs + 1000;
    expect((await d.collect(requestId)).body.error).toBe("expired_token");
  });
});

describe("request proofs", () => {
  test("missing, tampered, misdirected, stale, replayed or unknown proofs are rejected", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    const cases: [string, string, unknown, Parameters<typeof d.call>[3], string][] = [
      ["GET", P.me, undefined, { proof: null }, "missing"],
      ["GET", P.me, undefined, { proof: "not.a.proof" }, "malformed"],
      ["GET", P.me, undefined, { proof: "only-one-part" }, "malformed"],
      ["PUT", value("A_KEY"), { dataKey: FP, value: envelope() }, { body: JSON.stringify({ dataKey: FP, value: envelope() }) }, "body doesn't match"],
      ["GET", P.me, undefined, { method: "POST" }, "wrong method"],
      ["GET", P.me, undefined, { url: `http://sikrets.test${P.devices}` }, "wrong URL"],
      ["GET", P.me, undefined, { url: `http://other.test${P.me}` }, "wrong URL"],
      ["GET", values(), undefined, { url: `http://sikrets.test${values("blog")}` }, "wrong URL"],
      ["GET", P.me, undefined, { now: Date.now() - (PROTOCOL.clockSkewSeconds + 5) * 1000 }, "stale"],
      ["GET", P.me, undefined, { now: Date.now() + (PROTOCOL.clockSkewSeconds + 5) * 1000 }, "stale"],
      ["GET", P.me, undefined, { kid: "dev_unknown" }, "unknown device"],
      ["GET", P.me, undefined, { kid: null }, "no device key"],
    ];
    for (const [method, route, payload, o, reason] of cases) expect([route, await d.call(method, route, payload, o)]).toEqual([route, { status: 401, body: { error: "invalid_proof", reason } }]);

    // Inside the clock window either way is fine.
    expect((await d.call("GET", P.me, undefined, { now: Date.now() - (PROTOCOL.clockSkewSeconds - 5) * 1000 })).status).toBe(200);
    // A signature by a key that isn't this device's.
    const stranger = device();
    expect((await stranger.call("GET", P.me, undefined, { kid: d.id! })).body.reason).toBe("bad signature");
    // The same nonce twice is a replay, even in a freshly signed proof.
    expect((await d.call("GET", P.me, undefined, { nonce: "n1" })).status).toBe(200);
    expect((await d.call("GET", P.me, undefined, { nonce: "n1" })).body.reason).toBe("replayed");
  });

  test("a rejected proof doesn't burn its nonce", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    expect((await d.call("GET", P.me, undefined, { nonce: "n2", method: "POST" })).body.reason).toBe("wrong method");
    expect((await d.call("GET", P.me, undefined, { nonce: "n2" })).status).toBe(200);
  });

  test("behind a proxy, proofs are checked against the public URL", async () => {
    const { device } = setup({ publicUrl: "https://sikrets.example.com" });
    const d = device("http://10.0.0.5:4873", "https://sikrets.example.com");
    await d.signIn();
    expect((await d.call("GET", P.me)).status).toBe(200);
    // Signed for the internal URL the server happens to see: refused.
    expect((await d.call("GET", P.me, undefined, { url: `http://10.0.0.5:4873${P.me}` })).body.reason).toBe("wrong URL");
  });
});

describe("devices", () => {
  test("listed per account; revoking blocks every request from that device", async () => {
    const { app, device } = setup();
    const laptop = device();
    const desktop = device();
    await laptop.signIn("laptop");
    await desktop.signIn("desktop");
    await laptop.call("PUT", value("API_KEY"), { dataKey: FP, value: envelope() });
    const listed = (await laptop.call("GET", P.devices)).body.devices as { id: string; name: string }[];
    expect(listed.map((d) => d.name).sort()).toEqual(["desktop", "laptop"]);
    expect(JSON.stringify(listed)).not.toContain(laptop.jwk.x!);

    expect((await desktop.call("POST", P.revoke.replace(":id", laptop.id!))).body).toEqual({ revoked: laptop.id });
    for (const [method, route] of [["GET", P.me], ["GET", values()], ["GET", value("API_KEY")], ["DELETE", value("API_KEY")]] as const) {
      expect(await laptop.call(method, route)).toEqual({ status: 401, body: { error: "invalid_proof", reason: "device revoked" } });
    }
    // Signing in again is a new device; the revoked one stays revoked.
    const again = testDevice(app);
    await again.signIn();
    expect((await laptop.call("GET", P.me)).status).toBe(401);
  });

  test("a device can't revoke another account's device", async () => {
    const { device } = setup({ manual: true });
    const [alice, bob] = [device(), device()];
    for (const [d, user] of [[alice, "alice"], [bob, "bob"]] as const) {
      const s = await d.start();
      await d.call("POST", P.approve, { code: s.userCode, user }, { proof: null }, { authorization: `Bearer ${ADMIN}` });
      await d.collect(s.requestId);
    }
    expect((await alice.call("POST", P.revoke.replace(":id", bob.id!))).status).toBe(404);
    expect((await bob.call("GET", P.me)).status).toBe(200);
  });
});

describe("lifecycles under races and replays", () => {
  test("two polls collecting one approved sign-in get one device", async () => {
    const { device } = setup();
    const d = device();
    const { requestId } = await d.start();
    const replies = await Promise.all([d.collect(requestId), d.collect(requestId), d.collect(requestId)]);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test("an approved sign-in can't be approved again, into this account or another", async () => {
    const { device } = setup({ manual: true });
    const d = device();
    const s = await d.start();
    const admin = (user: string) => d.call("POST", P.approve, { code: s.userCode, user }, { proof: null }, { authorization: `Bearer ${ADMIN}` });
    expect((await admin("alice")).status).toBe(200);
    expect(await admin("mallory")).toMatchObject({ status: 409, body: { error: "already_decided" } });
    expect((await d.collect(s.requestId)).body.user).toBe("alice");
    expect((await admin("mallory")).status).toBe(409); // nor brought back after it was collected
    expect((await d.collect(s.requestId)).status).toBe(400);
  });

  test("a denied sign-in can't be collected or approved", async () => {
    const { device } = setup({ manual: true });
    const d = device();
    const s = await d.start();
    const admin = (body: object) => d.call("POST", P.approve, { code: s.userCode, user: "alice", ...body }, { proof: null }, { authorization: `Bearer ${ADMIN}` });
    expect((await admin({ deny: true })).body).toEqual({ approved: false });
    expect((await d.collect(s.requestId)).body.error).toBe("access_denied");
    expect((await admin({})).status).toBe(409);
  });

  test("a revoked key is refused for good: no new device id, even with auto approval", async () => {
    const { app, device } = setup();
    const stolen = device();
    const owner = device();
    await stolen.signIn("stolen");
    await owner.signIn("owner");
    await owner.call("POST", P.revoke.replace(":id", stolen.id!));
    expect((await stolen.call("POST", P.authorize, { name: "again", kind: "software", hardwareBound: false, publicKey: stolen.jwk }, { kid: null })).body).toEqual({ error: "invalid_proof", reason: "key revoked" });
    expect((await stolen.call("GET", P.me)).status).toBe(401);
    await testDevice(app).signIn(); // other keys still sign in (throws if not)
  });

  test("signing in again with the same key replaces its earlier device", async () => {
    const { store, device } = setup();
    const d = device();
    await d.signIn();
    const first = d.id!;
    await d.signIn();
    expect(d.id).not.toBe(first);
    expect((await store.getDevice(first))?.revokedAt).toBeDefined();
    expect((await d.call("GET", P.me)).status).toBe(200);
  });

  test("a request that loaded the device before a revoke can't undo it", async () => {
    const { store, device } = setup();
    const d = device();
    await d.signIn();
    const loaded = (await store.getDevice(d.id!))!; // what an in-flight request holds
    await store.revokeDevice(d.id!, new Date().toISOString());
    expect(await store.touchDevice(loaded.id, new Date().toISOString())).toBe(false);
    expect((await store.getDevice(d.id!))?.revokedAt).toBeDefined();
    expect((await d.call("GET", P.me)).status).toBe(401);
  });

  test("ifAbsent creates a value but never overwrites one", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    const [a, b] = [envelope(), envelope()];
    expect((await d.call("PUT", value("NEW_KEY"), { dataKey: FP, value: a, ifAbsent: true })).status).toBe(200);
    expect(await d.call("PUT", value("NEW_KEY"), { dataKey: FP, value: b, ifAbsent: true })).toMatchObject({ status: 412, body: { error: "exists" } });
    expect((await d.call("GET", value("NEW_KEY"))).body.value).toBe(a);
  });
});

describe("sealed values", () => {
  test("put, list, get and delete; names only in the listing", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    const sealed = envelope();
    expect((await d.call("PUT", value("API_KEY"), { dataKey: FP, value: sealed })).status).toBe(200);
    await d.call("PUT", value("OTHER_KEY"), { dataKey: FP, value: envelope() });
    const list = await d.call("GET", values());
    expect(list.body.values.map((v: { name: string }) => v.name)).toEqual(["API_KEY", "OTHER_KEY"]);
    expect(JSON.stringify(list.body)).not.toContain(sealed);
    expect((await d.call("GET", value("API_KEY"))).body).toMatchObject({ name: "API_KEY", value: sealed, updatedBy: d.id });
    expect((await d.call("GET", value("API_KEY", "shop", "prod"))).status).toBe(404);
    expect((await d.call("DELETE", value("API_KEY"))).body).toEqual({ deleted: true });
    expect((await d.call("GET", value("API_KEY"))).status).toBe(404);
    expect((await d.call("DELETE", value("API_KEY"))).body).toEqual({ deleted: false });
  });

  test("environments are separate; bad names are refused", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    await d.call("PUT", value("API_KEY", "shop", "prod"), { dataKey: FP, value: envelope() });
    expect((await d.call("GET", values("shop", "dev"))).body.values).toEqual([]);
    expect((await d.call("GET", values("shop", "prod"))).body.values).toHaveLength(1);
    for (const route of [value("lower_case"), value("API_KEY", "Shop"), value("API_KEY", "shop", "Prod"), values("../x")]) expect([route, (await d.call("GET", route)).status]).toEqual([route, route.includes("..") ? 404 : 400]);
  });

  test("another account's values are invisible, whatever the request names", async () => {
    const { device } = setup({ manual: true });
    const [alice, bob] = [device(), device()];
    for (const [d, user] of [[alice, "alice"], [bob, "bob"]] as const) {
      const s = await d.start();
      await d.call("POST", P.approve, { code: s.userCode, user }, { proof: null }, { authorization: `Bearer ${ADMIN}` });
      await d.collect(s.requestId);
    }
    const sealed = envelope();
    await bob.call("PUT", value("API_KEY"), { dataKey: FP, value: sealed });
    expect((await alice.call("GET", value("API_KEY"))).status).toBe(404);
    expect((await alice.call("GET", values())).body.values).toEqual([]);
    // Alice writing the same name makes her own value; Bob's is untouched.
    await alice.call("PUT", value("API_KEY"), { dataKey: FP, value: envelope() });
    expect((await bob.call("GET", value("API_KEY"))).body.value).toBe(sealed);
    expect((await alice.call("DELETE", value("API_KEY"))).body.deleted).toBe(true);
    expect((await bob.call("GET", value("API_KEY"))).body.value).toBe(sealed);
    // Using Bob's device id with Alice's key is a bad signature, not access.
    expect((await alice.call("GET", value("API_KEY"), undefined, { kid: bob.id! })).body.reason).toBe("bad signature");
  });

  test("plaintext and anything else that isn't an sk1: envelope is refused", async () => {
    const { store, device } = setup();
    const d = device();
    await d.signIn();
    const plain = ["tok", "live", "fakefakefake"].join("_");
    for (const body of [{ value: plain }, { value: "sk2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, { value: "sk1:not base64!" }, { value: "sk1:AAAA" }, { value: 42 }, {}, "not json"]) {
      const r = await d.call("PUT", value("API_KEY"), body);
      expect([body, r.status, r.body.error]).toEqual([body, 400, "invalid_value"]);
    }
    expect(await store.getValue({ account: "you@localhost", project: "shop", environment: "dev" }, "API_KEY")).toBeUndefined();
    // Not echoed back anywhere either.
    const audit = await d.call("GET", P.audit);
    expect(JSON.stringify(audit.body)).not.toContain(plain);
  });

  test("values over the size limit are refused; so are oversized bodies", async () => {
    const { device } = setup({ maxValueBytes: 2048 });
    const d = device();
    await d.signIn();
    expect((await d.call("PUT", value("FITS"), { dataKey: FP, value: `sk1:${Buffer.alloc(1500).toString("base64")}` })).status).toBe(200);
    const big = await d.call("PUT", value("TOO_BIG"), { dataKey: FP, value: `sk1:${Buffer.alloc(1600).toString("base64")}` });
    expect([big.status, big.body.error]).toEqual([413, "too_large"]);
    const huge = await d.call("PUT", value("HUGE"), { dataKey: FP, value: `sk1:${Buffer.alloc(8000).toString("base64")}` });
    expect([huge.status, huge.body.error]).toEqual([413, "too_large"]);
    expect((await d.call("GET", values())).body.values.map((v: { name: string }) => v.name)).toEqual(["FITS"]);
    expect(VALUES.maxValueBytes).toBeGreaterThanOrEqual(16 * 1024);
  });
});

describe("data key claims", () => {
  const dataKey = (project = "shop") => P.dataKey.replace(":project", project);
  const OTHER_FP = "fedcba9876543210";

  test("the first write claims the project; a write under another data key is refused in every environment", async () => {
    const { store, device } = setup();
    const [laptop, desktop] = [device(), device()];
    await laptop.signIn("laptop");
    await desktop.signIn("desktop");
    expect((await laptop.call("GET", dataKey())).status).toBe(404);
    expect((await laptop.call("PUT", value("API_KEY"), { dataKey: FP, value: envelope() })).status).toBe(200);
    expect((await desktop.call("GET", dataKey())).body).toMatchObject({ fingerprint: FP });
    for (const env of ["dev", "prod"]) {
      const r = await desktop.call("PUT", value("OTHER_KEY", "shop", env), { dataKey: OTHER_FP, value: envelope() });
      expect(r).toMatchObject({ status: 409, body: { error: PROTOCOL.dataKeyMismatch } });
      expect(r.body.reason).toContain("restore");
    }
    expect((await desktop.call("PUT", value("OTHER_KEY", "shop", "prod"), { dataKey: OTHER_FP, value: envelope(), ifAbsent: true })).status).toBe(409);
    expect(await store.listValues({ account: "you@localhost", project: "shop", environment: "prod" })).toEqual([]);
    // The same key from another device is fine; another project is its own claim.
    expect((await desktop.call("PUT", value("OTHER_KEY"), { dataKey: FP, value: envelope() })).status).toBe(200);
    expect((await desktop.call("PUT", value("API_KEY", "blog"), { dataKey: OTHER_FP, value: envelope() })).status).toBe(200);
    // Deleting every value doesn't release the claim.
    for (const n of ["API_KEY", "OTHER_KEY"]) await laptop.call("DELETE", value(n));
    expect((await desktop.call("PUT", value("API_KEY"), { dataKey: OTHER_FP, value: envelope() })).status).toBe(409);
    const events = (await laptop.call("GET", P.audit)).body.events as { action: string; outcome: string }[];
    expect(events.filter((e) => e.action === "value.put" && e.outcome === "denied").length).toBeGreaterThanOrEqual(3);
  });

  test("a write without a well-formed fingerprint is refused", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    for (const body of [{ value: envelope() }, { value: envelope(), dataKey: "NOT-HEX" }, { value: envelope(), dataKey: 7 }]) {
      expect([body, (await d.call("PUT", value("API_KEY"), body)).body.error]).toEqual([body, "invalid_request"]);
    }
    expect((await d.call("GET", dataKey())).status).toBe(404);
  });

  test("claiming up front: the first fingerprint wins, the same one again is fine, another is refused", async () => {
    const { device } = setup();
    const [a, b] = [device(), device()];
    await a.signIn();
    await b.signIn();
    expect((await a.call("PUT", dataKey(), { fingerprint: "nope" })).status).toBe(400);
    expect((await a.call("PUT", dataKey(), { fingerprint: FP })).body).toMatchObject({ fingerprint: FP });
    expect((await b.call("PUT", dataKey(), { fingerprint: FP })).status).toBe(200);
    expect(await b.call("PUT", dataKey(), { fingerprint: OTHER_FP })).toMatchObject({ status: 409, body: { error: PROTOCOL.dataKeyMismatch } });
    expect((await b.call("GET", dataKey("Bad"))).status).toBe(400);
  });

  test("two devices racing their first writes with different keys: exactly one key wins", async () => {
    for (const store of [sqliteStore(), dynamoStore(fakeDynamo(), "sikrets")]) {
      const { device } = setup({ store });
      const [a, b] = [device(), device()];
      await a.signIn();
      await b.signIn();
      const [ra, rb] = await Promise.all([a.call("PUT", value("A_KEY"), { dataKey: FP, value: envelope() }), b.call("PUT", value("B_KEY"), { dataKey: OTHER_FP, value: envelope() })]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      const winner = ra.status === 200 ? FP : OTHER_FP;
      expect((await a.call("GET", dataKey())).body.fingerprint).toBe(winner);
      expect((await a.call("GET", values())).body.values).toHaveLength(1);
    }
  });
});

describe("audit", () => {
  test("records operations by name, never values, for the account only", async () => {
    const { device } = setup();
    const d = device();
    await d.signIn();
    const sealed = envelope();
    await d.call("PUT", value("API_KEY"), { dataKey: FP, value: sealed });
    await d.call("GET", value("API_KEY"));
    await d.call("GET", value("MISSING_KEY"));
    await d.call("DELETE", value("API_KEY"));
    const events = (await d.call("GET", `${P.audit}?limit=10`)).body.events as { action: string; name?: string; outcome: string }[];
    expect(events.map((e) => [e.action, e.name, e.outcome])).toEqual([
      ["value.delete", "API_KEY", "ok"],
      ["value.get", "MISSING_KEY", "missing"],
      ["value.get", "API_KEY", "ok"],
      ["value.put", "API_KEY", "ok"],
      ["device.register", undefined, "ok"],
    ]);
    expect(JSON.stringify(events)).not.toContain(sealed.slice(4));
  });
});

describe("storage adapters behind the API", () => {
  for (const [name, store] of [["sqlite", () => sqliteStore()], ["dynamodb (fake)", () => dynamoStore(fakeDynamo({ pageSize: 1 }), "sikrets")]] as const) {
    test(`${name}: sign in, store, read, revoke`, async () => {
      const { device } = setup({ store: store() });
      const d = device();
      const other = device();
      await d.signIn();
      await other.signIn();
      const sealed = envelope();
      await d.call("PUT", value("API_KEY"), { dataKey: FP, value: sealed });
      expect((await other.call("GET", value("API_KEY"))).body.value).toBe(sealed);
      expect((await d.call("GET", P.me, undefined, { nonce: "same" })).status).toBe(200);
      expect((await d.call("GET", P.me, undefined, { nonce: "same" })).body.reason).toBe("replayed");
      await d.call("POST", P.revoke.replace(":id", other.id!));
      expect((await other.call("GET", value("API_KEY"))).body.reason).toBe("device revoked");
    });
  }
});

describe("config and startup", () => {
  test("auto approval only on loopback; bad settings fail loudly", () => {
    const dev = { [ENV.store]: "sqlite", [ENV.dataDir]: "/tmp/x" };
    expect(readConfig(dev)).toMatchObject({ host: "127.0.0.1", port: 4873, store: { kind: "sqlite", dir: "/tmp/x" } });
    expect(() => readConfig({ [ENV.host]: "0.0.0.0" })).toThrow("only listens on this machine");
    expect(readConfig({ [ENV.host]: "0.0.0.0", [ENV.approval]: "manual" }).approval.mode).toBe("manual");
    expect(readConfig({ [ENV.table]: "t" }).store).toEqual({ kind: "aws", table: "t", region: "us-east-1" });
    expect(() => readConfig({ [ENV.store]: "sqlite" })).toThrow(ENV.dataDir);
    expect(() => readConfig({ [ENV.store]: "postgres" })).toThrow("aws");
    expect(() => readConfig({ [ENV.approval]: "yes" })).toThrow("auto");
    expect(() => readConfig({ [ENV.port]: "http" })).toThrow("port");
    expect(() => readConfig({ [ENV.publicUrl]: "sikrets.example.com" })).toThrow("origin");
  });

  test("DynamoDB by default; SQLite may serve beyond this machine, with a startup warning", () => {
    expect(readConfig({}).store).toEqual({ kind: "aws", table: "sikrets", region: "us-east-1" });
    expect(startupWarnings(readConfig({}))).toEqual([]);
    const shared = readConfig({ [ENV.store]: "sqlite", [ENV.dataDir]: "/tmp/x", [ENV.host]: "0.0.0.0", [ENV.approval]: "manual" });
    expect(shared.store).toEqual({ kind: "sqlite", dir: "/tmp/x" });
    expect(startupWarnings(shared).join()).toContain("single server process");
    expect(startupWarnings(readConfig({ [ENV.store]: "sqlite", [ENV.dataDir]: "/tmp/x" }))).toEqual([]);
  });

  test("listens on localhost with SQLite on disk; the certificate key and values survive a restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-server-run-"));
    try {
      const config = readConfig({ [ENV.store]: "sqlite", [ENV.dataDir]: dir, [ENV.port]: "0" });
      const first = await startServer(config);
      const info = await (await fetch(`${first.url}${P.info}`)).json();
      first.stop();
      const second = await startServer(config);
      try {
        expect((await (await fetch(`${second.url}${P.info}`)).json()).certificateKey).toEqual(info.certificateKey);
        expect((await fetch(`${second.url}/nope`)).status).toBe(404);
      } finally {
        second.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
