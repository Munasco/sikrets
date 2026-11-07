import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDataKey as sdkLoadDataKey } from "../../sdk/src/datakey.ts";
import { ensureDataKey, loadDataKey } from "./core/datakey.ts";
import { deviceClient } from "./core/device-auth.ts";
import { deviceDir, resetDeviceCache, thisDevice } from "./core/device.ts";
import { startDeviceServer } from "./testing/device-server.ts";
import { DEVICE, ENV } from "./constants.ts";

// The real Secure Enclave, end to end: builds the helper, creates both keys, wraps and unwraps a
// data key, opens it from the SDK through the helper, and signs in to the fake server. Silent: the
// keys have no user-presence requirement, so nothing prompts. Opt in with SIKRETS_ENCLAVE_SMOKE=1
// on a Mac with swiftc; everything lives in a throwaway config dir that is deleted afterwards.

const enabled = process.platform === "darwin" && Bun.env[ENV.enclaveSmoke] === "1";

describe.skipIf(!enabled)("Secure Enclave (smoke)", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "sikrets-enclave-"));
    process.env[ENV.configDir] = home;
    delete process.env[ENV.deviceKeys];
    resetDeviceCache();
  });
  afterAll(async () => {
    process.env[ENV.deviceKeys] = DEVICE.forceSoftware;
    delete process.env[ENV.configDir];
    resetDeviceCache();
    await rm(home, { recursive: true, force: true });
  });

  test("keys are created in the Enclave and work", async () => {
    const device = await thisDevice();
    expect(device.meta.kind).toBe("secure-enclave");
    expect(device.hardwareBound).toBe(true);
    expect(await device.works()).toBe(true);
    for (const f of [DEVICE.signingKey, DEVICE.agreementKey]) expect((await stat(path.join(deviceDir(), f))).mode & 0o777).toBe(0o600);
  }, 120_000);

  test("the data key round-trips through the Enclave, from the CLI and the SDK", async () => {
    const key = await ensureDataKey();
    resetDeviceCache();
    expect((await loadDataKey())!.equals(key)).toBe(true);
    expect((await sdkLoadDataKey(undefined))!.equals(key)).toBe(true);
  }, 60_000);

  test("signs in and signs requests", async () => {
    const server = startDeviceServer({ autoApprove: "you@localhost" });
    try {
      const client = deviceClient({ server: server.url, device: await thisDevice() });
      const session = await client.login({ approve: () => {} });
      expect(session.hardwareBound).toBe(true);
      expect(await client.me(session)).toEqual({ user: "you@localhost", deviceId: session.deviceId });
    } finally {
      server.stop();
    }
  }, 60_000);
});
