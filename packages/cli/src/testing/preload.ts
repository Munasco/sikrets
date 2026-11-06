import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { transport } from "../core/device-auth.ts";
import { DEFAULT_USER, inProcessServer } from "./device-server.ts";
import { DEVICE, ENV } from "../constants.ts";

// Loaded before every test file (bunfig.toml). The real Secure Enclave is only used by the opt-in
// smoke test, which builds its own backend.
process.env[ENV.deviceKeys] = DEVICE.forceSoftware;

// Every test gets a fresh, in-memory Sikrets server (the real one, packages/server) that approves
// sign-ins itself, reached without a socket, and a throwaway user folder unless it sets its own.
// Nothing leaves the process and nothing touches ~/.sikrets.
export const TEST_SERVER = "http://sikrets.test";
let server = inProcessServer(TEST_SERVER, { autoApprove: DEFAULT_USER });
let home: string | undefined;

transport.fetch = (input, init) => (input.startsWith(`${TEST_SERVER}/`) ? server.fetch(input, init) : fetch(input, init));

beforeEach(async () => {
  server.stop();
  server = inProcessServer(TEST_SERVER, { autoApprove: DEFAULT_USER });
  process.env[ENV.server] = TEST_SERVER;
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-test-home-"));
  process.env[ENV.configDir] = home;
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

/** The current test's server, to look at what it stored. */
export const testServer = () => server;
