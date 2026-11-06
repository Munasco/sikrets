import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomBytes, sign as signWith } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dataKeyFile, ensureDataKey, fingerprint, loadDataKey } from "./core/datakey.ts";
import { clearSession, deviceClient, DeviceAuthError, readSession, writeSession, type DeviceSession } from "./core/device-auth.ts";
import { deviceDir, DeviceMismatchError, enclave, HelperMissingError, pointToJwk, readDeviceMeta, resetDevice, software, thisDevice, thumbprint, type Device, type DataKeyWrap } from "./core/device.ts";
import { createProof, type Signer } from "./core/proof.ts";
import { newCode, readRecord, wrap, writeRecord } from "./core/recovery.ts";
import { startDeviceServer, type TestServer } from "./testing/device-server.ts";
import { DEVICE, DEVICE_AUTH, ENV } from "./constants.ts";

// Device identity: keys created in a (fake) Secure Enclave or as software keys, the data key wrapped
// to the device, and sign-in with a signed proof on every request against the real server
// (packages/server, in memory on a random localhost port).
// The Secure Enclave is replaced by an in-process fake built on the software backend, so no test
// runs the native helper or shows a dialog. Nothing private is ever printed; output is captured.

const keychain = new Map<string, string>();
let home: string;
let out: string[];
let server: TestServer | undefined;

/** The Secure Enclave, faked: software keys underneath, reported as hardware-bound. */
function fakeEnclave(available = true) {
  return {
    available: spyOn(enclave, "available").mockImplementation(async () => available),
    create: spyOn(enclave, "create").mockImplementation(software.create),
    sign: spyOn(enclave, "sign").mockImplementation(software.sign),
    unwrap: spyOn(enclave, "unwrap").mockImplementation(async (file, input) => {
      // Like device.swift: exactly these string fields, nothing else.
      if (Object.keys(input).sort().join() !== UNWRAP_FIELDS || Object.values(input).some((v) => typeof v !== "string")) throw new Error("expected a JSON object of strings");
      return software.unwrap(file, input);
    }),
  };
}
const UNWRAP_FIELDS = ["aad", "ct", "epk", "info", "iv", "salt", "tag"].join();

beforeEach(async () => {
  keychain.clear();
  out = [];
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-device-"));
  process.env[ENV.configDir] = home;
  delete process.env[ENV.deviceKeys]; // the preload forces software keys; these tests choose
  delete process.env[ENV.server]; // these tests start their own servers and use the saved one
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
});

afterEach(async () => {
  mock.restore();
  server?.stop();
  server = undefined;
  process.env[ENV.deviceKeys] = DEVICE.forceSoftware;
  delete process.env[ENV.configDir];
  await rm(home, { recursive: true, force: true });
});

const printed = () => out.join("\n");
const command = async (name: string) => (await import(`./commands/${name}.ts`)) as { run: (args: string[], opts: Record<string, unknown>) => Promise<void> };
const keyFiles = () => [DEVICE.signingKey, DEVICE.agreementKey].map((f) => path.join(deviceDir(), f));
const readWrapped = async () => (await Bun.file(dataKeyFile()).json()) as DataKeyWrap;

describe("device keys", () => {
  test("live in the Secure Enclave when there is one: 0600 blobs, public keys only in the metadata", async () => {
    const se = fakeEnclave();
    const device = await thisDevice();
    expect(device.meta.kind).toBe("secure-enclave");
    expect(device.hardwareBound).toBe(true);
    expect(se.create).toHaveBeenCalledTimes(2);
    for (const f of keyFiles()) expect((await stat(f)).mode & 0o777).toBe(0o600);
    expect((await stat(deviceDir())).mode & 0o777).toBe(0o700);
    const meta = await Bun.file(path.join(deviceDir(), DEVICE.metaFile)).text();
    for (const f of keyFiles()) expect(meta).not.toContain((await Bun.file(f).text()).split("\n")[1]!);
    // Created once: the same keys next time.
    expect((await thisDevice()).signingPublicKey.equals(device.signingPublicKey)).toBe(true);
  });

  test("without a Secure Enclave: software keys, and every view says not hardware-bound", async () => {
    fakeEnclave(false);
    const device = await thisDevice();
    expect(device.meta.kind).toBe("software");
    expect(device.hardwareBound).toBe(false);
    await (await command("devices")).run([], {});
    expect(printed()).toContain("This device: software key (not hardware-bound)");
    out.length = 0;
    await (await command("devices")).run([], { json: true });
    expect(JSON.parse(out[0]!).thisDevice).toMatchObject({ kind: "software", hardwareBound: false });
  });

  test("SIKRETS_DEVICE_KEYS=software skips the Enclave even where there is one", async () => {
    const se = fakeEnclave();
    process.env[ENV.deviceKeys] = DEVICE.forceSoftware;
    expect((await thisDevice()).meta.kind).toBe("software");
    expect(se.available).not.toHaveBeenCalled();
  });

  test("Enclave keys never fall back to software silently when the helper is gone", async () => {
    const se = fakeEnclave();
    await ensureDataKey();
    se.unwrap.mockImplementation(async () => {
      throw new HelperMissingError("The Secure Enclave helper couldn't be built");
    });
    await expect(loadDataKey()).rejects.toBeInstanceOf(HelperMissingError);
    expect((await readDeviceMeta())!.kind).toBe("secure-enclave");
  });
});

describe("data key wrapped to the device", () => {
  test("round-trips, and the file holds neither the key nor anything another device can open", async () => {
    fakeEnclave();
    const key = await ensureDataKey();
    const wrapped = await readWrapped();
    expect(JSON.stringify(wrapped)).not.toContain(key.toString("base64"));
    expect(wrapped.recipient).toBe(thumbprint((await thisDevice()).agreementPublicKey));
    expect((await stat(dataKeyFile())).mode & 0o777).toBe(0o600);
    expect((await loadDataKey())!.equals(key)).toBe(true);

    // The whole folder copied to another machine: that machine's keys are different.
    await resetDevice();
    await Bun.write(dataKeyFile(), JSON.stringify(wrapped));
    await expect(loadDataKey()).rejects.toBeInstanceOf(DeviceMismatchError); // no device keys here, and none are made over a wrapped key
    await rm(dataKeyFile());
    const other = await thisDevice();
    await expect(other.unwrap(wrapped)).rejects.toBeInstanceOf(DeviceMismatchError);
    // Even with the recipient field forged to match, the other device's key can't open it.
    await expect(other.unwrap({ ...wrapped, recipient: thumbprint(other.agreementPublicKey) })).rejects.toBeInstanceOf(DeviceMismatchError);
  });

  test("a raw data key in the keychain is migrated: wrapped, verified, then removed", async () => {
    const se = fakeEnclave();
    const key = randomBytes(32);
    keychain.set("dev.sikrets.datakey/default", key.toString("base64"));
    expect((await loadDataKey())!.equals(key)).toBe(true);
    expect(keychain.has("dev.sikrets.datakey/default")).toBe(false);
    expect((await readWrapped()).fingerprint).toBe(fingerprint(key));
    expect(se.unwrap).toHaveBeenCalledTimes(1); // the verifying round trip
    expect((await loadDataKey())!.equals(key)).toBe(true);
  });

  test("migration keeps the raw copy when the round trip doesn't verify", async () => {
    const se = fakeEnclave();
    const key = randomBytes(32);
    keychain.set("dev.sikrets.datakey/default", key.toString("base64"));
    se.unwrap.mockImplementation(async () => randomBytes(32));
    expect((await loadDataKey())!.equals(key)).toBe(true);
    expect(keychain.get("dev.sikrets.datakey/default")).toBe(key.toString("base64"));
    expect(await Bun.file(dataKeyFile()).exists()).toBe(false);
    // Fixed (e.g. the helper works again): the next load migrates.
    se.unwrap.mockRestore();
    fakeEnclave();
    expect((await loadDataKey())!.equals(key)).toBe(true);
    expect(keychain.has("dev.sikrets.datakey/default")).toBe(false);
  });

  test("recovery restore on a new device re-wraps the key to that device", async () => {
    fakeEnclave();
    const key = await ensureDataKey();
    const { secret, shown } = newCode();
    await writeRecord(await wrap(key, secret));
    const kept = path.join(home, "kept-recovery.json");
    await Bun.write(kept, await Bun.file(path.join(home, "recovery.json")).text());
    const oldRecipient = (await readWrapped()).recipient;

    await resetDevice(); // the laptop is gone; this is the new one
    spyOn(Bun.stdin, "text").mockImplementation(async () => `${shown[0]}\n`);
    await (await command("recovery")).run(["restore"], { file: kept, "code-stdin": true });

    const wrapped = await readWrapped();
    expect(wrapped.recipient).not.toBe(oldRecipient);
    expect(wrapped.recipient).toBe(thumbprint((await thisDevice()).agreementPublicKey));
    expect((await loadDataKey())!.equals(key)).toBe(true);
    expect((await readRecord())!.fingerprint).toBe(fingerprint(key));
    expect(printed()).not.toContain(shown[0]!);
  });

  test("restore over a wrapped key copied from another device needs --force, then re-wraps", async () => {
    fakeEnclave();
    const key = await ensureDataKey();
    const { secret, shown } = newCode();
    await writeRecord(await wrap(key, secret));
    const copied = await readWrapped();

    await resetDevice();
    await thisDevice(); // this machine's own keys
    await Bun.write(dataKeyFile(), JSON.stringify(copied)); // a backup restored over it
    spyOn(Bun.stdin, "text").mockImplementation(async () => `${shown[0]}\n`);
    await expect((await command("recovery")).run(["restore"], { "code-stdin": true })).rejects.toThrow("--force");
    await (await command("recovery")).run(["restore"], { "code-stdin": true, force: true });
    expect((await loadDataKey())!.equals(key)).toBe(true);
  });
});

describe("request proofs", () => {
  let device: Device;
  let session: DeviceSession;
  const sign: Signer = (d) => device.sign(d);
  const call = async (route: string, init: { method?: string; body?: string; proof?: string | null; proofUrl?: string; proofMethod?: string; proofBody?: string; now?: number; nonce?: string } = {}) => {
    const method = init.method ?? "GET";
    const url = `${server!.url}${route}`;
    const proof = init.proof !== undefined ? init.proof : await createProof(sign, { method: init.proofMethod ?? method, url: init.proofUrl ?? url, body: init.proofBody ?? init.body }, { kid: session.deviceId }, { now: init.now, nonce: init.nonce });
    const res = await fetch(url, { method, body: init.body, headers: proof ? { [DEVICE_AUTH.proofHeader]: proof } : {} });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };

  beforeEach(async () => {
    fakeEnclave();
    server = startDeviceServer({ autoApprove: "you@localhost" });
    device = await thisDevice();
    session = await deviceClient({ server: server.url, device }).login({ approve: () => {} });
  });

  test("a valid proof is accepted", async () => {
    expect(await call(DEVICE_AUTH.paths.me)).toEqual({ status: 200, body: { user: "you@localhost", deviceId: session.deviceId } });
  });

  test("missing, tampered or misdirected proofs are rejected", async () => {
    const revoke = DEVICE_AUTH.paths.revoke("dev_nope");
    const cases: [string, Parameters<typeof call>[1], string][] = [
      [DEVICE_AUTH.paths.me, { proof: null }, "missing"],
      [revoke, { method: "POST", body: '{"a":1}', proofBody: '{"a":2}' }, "body doesn't match"],
      [DEVICE_AUTH.paths.me, { proofMethod: "POST" }, "wrong method"],
      [DEVICE_AUTH.paths.me, { proofUrl: `${server!.url}${DEVICE_AUTH.paths.devices}` }, "wrong URL"],
      [DEVICE_AUTH.paths.me, { proofUrl: `${server!.url}${DEVICE_AUTH.paths.me}?as=someone` }, "wrong URL"],
      [DEVICE_AUTH.paths.me, { now: Date.now() - (DEVICE_AUTH.clockSkewSeconds + 5) * 1000 }, "stale"],
      [DEVICE_AUTH.paths.me, { now: Date.now() + (DEVICE_AUTH.clockSkewSeconds + 5) * 1000 }, "stale"],
      [DEVICE_AUTH.paths.me, { proof: "not.a.proof" }, "malformed"],
    ];
    for (const [route, init, reason] of cases) expect(await call(route, init)).toEqual({ status: 401, body: { error: "invalid_proof", reason } });

    // Signed by a key that isn't this device's.
    const stranger = generateSigner();
    const forged = await createProof(stranger, { method: "GET", url: `${server!.url}${DEVICE_AUTH.paths.me}` }, { kid: session.deviceId });
    expect((await call(DEVICE_AUTH.paths.me, { proof: forged })).body.reason).toBe("bad signature");
    // A valid signature with the payload swapped.
    const good = await createProof(sign, { method: "GET", url: `${server!.url}${DEVICE_AUTH.paths.me}` }, { kid: session.deviceId });
    const other = await createProof(sign, { method: "GET", url: `${server!.url}${DEVICE_AUTH.paths.devices}` }, { kid: session.deviceId });
    const spliced = [good.split(".")[0], other.split(".")[1], good.split(".")[2]].join(".");
    expect((await call(DEVICE_AUTH.paths.devices, { proof: spliced })).body.reason).toBe("bad signature");
  });

  test("a nonce works once", async () => {
    const proof = await createProof(sign, { method: "GET", url: `${server!.url}${DEVICE_AUTH.paths.me}` }, { kid: session.deviceId });
    expect((await call(DEVICE_AUTH.paths.me, { proof })).status).toBe(200);
    expect(await call(DEVICE_AUTH.paths.me, { proof })).toEqual({ status: 401, body: { error: "invalid_proof", reason: "replayed" } });
    // Same nonce in a freshly signed proof is still a replay.
    expect((await call(DEVICE_AUTH.paths.me, { nonce: "n1" })).status).toBe(200);
    expect((await call(DEVICE_AUTH.paths.me, { nonce: "n1" })).body.reason).toBe("replayed");
  });

  test("a revoked device's proofs are rejected", async () => {
    await deviceClient({ server: server!.url, device }).revoke(session, session.deviceId);
    expect(await call(DEVICE_AUTH.paths.me)).toEqual({ status: 401, body: { error: "invalid_proof", reason: "device revoked" } });
  });
});

/** A throwaway signer whose key isn't registered anywhere. */
function generateSigner(): Signer {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return async (d) => signWith("sha256", d, { key: privateKey, dsaEncoding: "ieee-p1363" });
}

describe("sign-in", () => {
  test("waits for the browser approval, then returns a device id and certificate", async () => {
    fakeEnclave();
    server = startDeviceServer();
    const device = await thisDevice();
    let code = "";
    let polls = 0;
    // Still pending on the first poll; the person approves before the second.
    const sleep = async () => {
      if (polls++ === 0) await server!.approve(code, "me@example.test");
    };
    const session = await deviceClient({ server: server.url, device, sleep }).login({
      name: "test-mac",
      approve: (a) => {
        expect(a.url).toBe(`${server!.url}${DEVICE_AUTH.paths.approve}?code=${a.userCode}`);
        code = a.userCode;
      },
    });
    expect(polls).toBe(1);
    expect(session).toMatchObject({ server: server.url, user: "me@example.test", kind: "secure-enclave", hardwareBound: true });
    expect(session.deviceId).toStartWith(DEVICE_AUTH.deviceIdPrefix);
    // The certificate binds the device id to this device's key.
    const cert = JSON.parse(Buffer.from(session.certificate.split(".")[1]!, "base64url").toString());
    expect(cert).toMatchObject({ sub: session.deviceId, user: "me@example.test", hw: true });
    expect((await server.devices("me@example.test"))[0]!.jwk).toEqual(pointToJwk(device.signingPublicKey));
  });

  test("only the key that started a sign-in can collect it, and registering needs that key's signature", async () => {
    fakeEnclave();
    server = startDeviceServer({ autoApprove: "you@localhost" });
    const device = await thisDevice();
    const jwk = pointToJwk(device.signingPublicKey);
    const post = async (route: string, payload: unknown, signer: Signer, key: JsonWebKey) => {
      const url = `${server!.url}${route}`;
      const body = JSON.stringify(payload);
      const proof = await createProof(signer, { method: "POST", url, body }, { jwk: key });
      const res = await fetch(url, { method: "POST", body, headers: { [DEVICE_AUTH.proofHeader]: proof } });
      return { status: res.status, body: (await res.json()) as Record<string, string> };
    };
    // Claiming this device's key without holding it.
    const stranger = generateSigner();
    expect((await post(DEVICE_AUTH.paths.authorize, { publicKey: jwk }, stranger, jwk)).body.reason).toBe("bad signature");
    const started = await post(DEVICE_AUTH.paths.authorize, { publicKey: jwk, name: "mac" }, (d) => device.sign(d), jwk);
    expect(started.status).toBe(200);
    // Another key tries to collect the approved sign-in.
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const otherJwk = publicKey.export({ format: "jwk" });
    const other: Signer = async (d) => signWith("sha256", d, { key: privateKey, dsaEncoding: "ieee-p1363" });
    expect(await post(DEVICE_AUTH.paths.token, { requestId: started.body.requestId }, other, otherJwk)).toEqual({ status: 400, body: { error: "invalid_grant", reason: "a different key started this sign-in" } });
    expect((await post(DEVICE_AUTH.paths.token, { requestId: started.body.requestId }, (d) => device.sign(d), jwk)).status).toBe(200);
  });

  test("login, devices, revoke another device, logout: end to end through the commands", async () => {
    fakeEnclave();
    server = startDeviceServer({ autoApprove: "you@localhost" });

    // A second device on the same account (its own config dir and keys).
    const laptop = await mkdtemp(path.join(os.tmpdir(), "sikrets-device-laptop-"));
    process.env[ENV.configDir] = laptop;
    const laptopDevice = await thisDevice();
    const laptopSession = await deviceClient({ server: server.url, device: laptopDevice }).login({ approve: () => {} });
    process.env[ENV.configDir] = home;

    await (await command("login")).run([], { server: server.url, "no-browser": true });
    const session = (await readSession())!;
    expect((await stat(path.join(deviceDir(), DEVICE.sessionFile))).mode & 0o777).toBe(0o600);
    expect(printed()).toContain(`Signed in as you@localhost on ${server.url}. This device is ${session.deviceId}, with a Secure Enclave (hardware-bound).`);

    out.length = 0;
    await (await command("devices")).run([], {});
    expect(printed()).toContain("This device: Secure Enclave (hardware-bound)");
    expect(printed()).toContain(`* ${session.deviceId}`);
    expect(printed()).toContain(laptopSession.deviceId);

    await (await command("devices")).run(["revoke", laptopSession.deviceId], {});
    const fromLaptop = deviceClient({ server: server.url, device: laptopDevice });
    await expect(fromLaptop.me(laptopSession)).rejects.toThrow("device revoked");
    out.length = 0;
    await (await command("devices")).run([], { json: true });
    const listed = JSON.parse(out[0]!) as { devices: { id: string; revokedAt?: string }[] };
    expect(listed.devices.find((d) => d.id === laptopSession.deviceId)!.revokedAt).toBeDefined();

    await (await command("logout")).run([], {});
    expect(await readSession()).toBeUndefined();
    const client = deviceClient({ server: server.url, device: await thisDevice() });
    const error = await client.me(session).catch((e) => e);
    expect(error).toBeInstanceOf(DeviceAuthError);
    expect((error as DeviceAuthError).status).toBe(401);
    // Signing out leaves the device key (it wraps the data key).
    expect(await readDeviceMeta()).toBeDefined();
    // Nothing private reached the output.
    const secrets = await Promise.all(keyFiles().map((f) => Bun.file(f).text()));
    for (const s of secrets) for (const line of s.split("\n").filter((l) => l.length > 20)) expect(printed()).not.toContain(line);
    await rm(laptop, { recursive: true, force: true });
  });

  test("devices without a sign-in shows only this device and how to sign in", async () => {
    fakeEnclave();
    await clearSession();
    await (await command("devices")).run([], {});
    expect(printed()).toContain("This device: no device key yet");
    expect(printed()).toContain("Not signed in. Run: sikrets login");
    await writeSession({ version: 1, server: "http://127.0.0.1:9", deviceId: "dev_x", user: "u", certificate: "c", kind: "software", hardwareBound: false, signedInAt: new Date().toISOString() });
    out.length = 0;
    await (await command("logout")).run([], {});
    expect(printed()).toContain("Couldn't revoke dev_x");
    expect(await readSession()).toBeUndefined();
  });
});
