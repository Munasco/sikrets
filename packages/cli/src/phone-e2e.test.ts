import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AAD, MESSAGE_IDS, createPhoneIdentity, decodeOffer, mailbox, messageId, open, relayClient, seal, sealHello, sessionKey, signDecision, type Snapshot } from "@sikrets/pairing";
import { approvals } from "./core/approvals.ts";
import { beginPairing } from "./core/pairing.ts";
import { snapshotId } from "./core/phone.ts";
import { state } from "./core/state.ts";
import { ENV } from "./constants.ts";

// End to end over real HTTP: a relay process (local by default, or the deployed one with
// SIKRETS_E2E_RELAY=<url>), the CLI's own `approvals` command, and a simulated phone using the
// app's crypto module. Only the provider call inside rotate is stubbed.

const rotated: string[] = [];

const keychain = new Map<string, string>();
let relayProc: ReturnType<typeof Bun.spawn> | undefined;
let relay: string;
let root: string;
let config: string;
const cwd = process.cwd();

beforeAll(async () => {
  mock.restore(); // real network: undo any fetch spy left by another test file
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sikrets-e2e-")));
  config = await mkdtemp(path.join(os.tmpdir(), "sikrets-e2e-config-"));
  Bun.env[ENV.configDir] = config;
  if (Bun.env.SIKRETS_E2E_RELAY) relay = Bun.env.SIKRETS_E2E_RELAY;
  else {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    relayProc = Bun.spawn(["bun", path.join(import.meta.dir, "../../../apps/relay/src/local.ts")], { env: { ...Bun.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
    relay = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${relay}/health`).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(100);
    }
  }
  await state.upsert(root, { name: "openai", recipe: "openai/api-key", provider: "openai", strategy: "api", inputs: {}, dependsOn: {}, envKeys: ["OPENAI_API_KEY"], outputs: {}, applied: true, createdAt: new Date().toISOString() });
  process.chdir(root);
}, 20_000);

afterAll(async () => {
  process.chdir(cwd);
  relayProc?.kill();
  delete Bun.env[ENV.configDir];
  await rm(root, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

test("pair, request, approve on the phone, rotate", async () => {
  const { run: cli, rotation } = await import("./commands/approvals.ts");
  spyOn(rotation, "run").mockImplementation(async (resource: string) => void rotated.push(resource));

  // Laptop shows the QR code (sikrets pair); the phone scans it and says hello.
  const session = beginPairing(relay);
  const offer = decodeOffer(session.qrText);
  const phone = createPhoneIdentity();
  const box = mailbox(offer.secret);
  const phoneRelay = relayClient(offer.relay);
  await phoneRelay.put(box.toCli, MESSAGE_IDS.hello, sealHello(offer.secret, { v: 1, encKey: phone.encPublicKey, signKey: phone.signPublicKey, name: "E2E iPhone", at: new Date().toISOString() }));
  expect((await session.poll())?.phoneName).toBe("E2E iPhone");

  // An agent files a request; the laptop sends it to the phone.
  await cli(["request", "openai"], { queue: true, reason: "exposed", json: true });
  const key = sessionKey(phone.encSecretKey, offer.cliKey, offer.secret);
  const snap = open<Snapshot>(key, AAD.toPhone, (await phoneRelay.list(box.toPhone)).find((m) => m.id === snapshotId(root))!.blob);
  const req = snap.requests[0]!;
  expect(req).toMatchObject({ resource: "openai", message: "We think this key may be exposed", status: "pending" });
  expect(snap.keys.map((k) => k.name)).toEqual(["openai"]);

  // The person approves with Face ID; the phone signs and posts.
  const signed = signDecision(phone.signSecretKey, { pairingId: box.pairingId, requestId: req.id, resource: req.resource, decision: "approve", challenge: req.challenge, issuedAt: new Date().toISOString() });
  const blob = seal(key, AAD.toCli, signed);
  await phoneRelay.put(box.toCli, messageId(), blob);

  // `sikrets approvals watch --once` verifies the signature and rotates.
  await cli(["watch"], { once: true, json: true });
  expect(rotated).toEqual(["openai"]);
  expect((await approvals.find(root, req.id)).status).toBe("rotated");

  // The relay replays the approval: nothing happens.
  await phoneRelay.put(box.toCli, messageId(), blob);
  await cli(["watch"], { once: true, json: true });
  expect(rotated).toEqual(["openai"]);

  // The phone sees the result in the next snapshot.
  const after = open<Snapshot>(key, AAD.toPhone, (await phoneRelay.list(box.toPhone)).find((m) => m.id === snapshotId(root))!.blob);
  expect(after.requests.find((r) => r.id === req.id)).toMatchObject({ status: "rotated", challenge: "" });
  await phoneRelay.remove(box.toPhone, snapshotId(root));
}, 30_000);
