import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AAD,
  MESSAGE_IDS,
  createPhoneIdentity,
  decodeOffer,
  mailbox,
  messageId,
  open,
  relayClient,
  seal,
  sealHello,
  sessionKey,
  signDecision,
  type Offer,
  type PhoneIdentity,
  type Snapshot,
  type UnpairNotice,
} from "@sikrets/pairing";
import { createRelay } from "../../../apps/relay/src/app.ts";
import { memoryStore } from "../../../apps/relay/src/store.ts";
import { applyEvent, approvals, requestRotation } from "./core/approvals.ts";
import { beginPairing, forgetPairing, loadLink, loadPairing, type Link } from "./core/pairing.ts";
import { PhoneUnpairedError, poll, push, snapshotId } from "./core/phone.ts";
import { state } from "./core/state.ts";
import { ENV } from "./constants.ts";

// The whole phone flow, in process: the real relay handler on an in-memory store, the CLI's pairing
// and Doorman code, and a simulated phone that uses the same crypto module as the app.

const RELAY_URL = "http://relay.test";
const keychain = new Map<string, string>();
let root: string;
let config: string;
let fetcher: typeof fetch;
let rotated: string[];
const rotate = async (resource: string) => void rotated.push(resource);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-phone-"));
  config = await mkdtemp(path.join(os.tmpdir(), "sikrets-phone-config-"));
  Bun.env[ENV.configDir] = config;
  keychain.clear();
  rotated = [];
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  const handle = createRelay(memoryStore());
  fetcher = (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch;
  await state.upsert(root, { name: "openai", recipe: "openai/api-key", provider: "openai", strategy: "api", inputs: {}, dependsOn: {}, envKeys: ["OPENAI_API_KEY"], outputs: {}, applied: true, createdAt: new Date().toISOString() });
});

afterEach(async () => {
  delete Bun.env[ENV.configDir];
  await rm(root, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** A phone that scanned the QR code: it holds what the app holds. */
class Phone {
  readonly id: PhoneIdentity = createPhoneIdentity();
  readonly offer: Offer;
  constructor(qrText: string) {
    this.offer = decodeOffer(qrText);
  }
  get box() {
    return mailbox(this.offer.secret);
  }
  get key() {
    return sessionKey(this.id.encSecretKey, this.offer.cliKey, this.offer.secret);
  }
  get relay() {
    return relayClient(this.offer.relay, fetcher);
  }
  hello() {
    return this.relay.put(this.box.toCli, MESSAGE_IDS.hello, sealHello(this.offer.secret, { v: 1, encKey: this.id.encPublicKey, signKey: this.id.signPublicKey, name: "Test iPhone", at: new Date().toISOString() }));
  }
  async snapshot(): Promise<Snapshot> {
    const msgs = await this.relay.list(this.box.toPhone);
    return open<Snapshot>(this.key, AAD.toPhone, msgs.find((m) => m.id === snapshotId(root))!.blob);
  }
  /** Signs a decision for a request as shown in the snapshot, and posts it. Returns the blob sent. */
  async answer(requestId: string, decision: "approve" | "deny", signKey = this.id.signSecretKey, over: { pairingId?: string } = {}) {
    const r = (await this.snapshot()).requests.find((x) => x.id === requestId)!;
    const signed = signDecision(signKey, { pairingId: over.pairingId ?? this.box.pairingId, requestId: r.id, resource: r.resource, decision, challenge: r.challenge, issuedAt: new Date().toISOString() });
    const blob = seal(this.key, AAD.toCli, signed);
    await this.relay.put(this.box.toCli, messageId(), blob);
    return blob;
  }
}

async function pairPhone(): Promise<{ phone: Phone; link: Link }> {
  const session = beginPairing(RELAY_URL, fetcher);
  expect(await session.poll()).toBeUndefined(); // nobody has scanned yet
  const phone = new Phone(session.qrText);
  await phone.hello();
  const pairing = await session.poll();
  expect(pairing?.phoneName).toBe("Test iPhone");
  return { phone, link: (await loadLink(fetcher))! };
}

describe("pairing", () => {
  test("QR scan + hello pairs the phone; secrets stay in the keychain", async () => {
    const { phone } = await pairPhone();
    const saved = (await loadPairing())!;
    expect(saved.phoneSignKey).toBe(phone.id.signPublicKey);
    const onDisk = await Bun.file(path.join(config, "pairing.json")).text();
    expect(onDisk).not.toContain(phone.offer.secret);
    expect([...keychain.keys()]).toEqual([`dev.sikrets.pairing/default-${saved.pairingId}`]);
    expect(await phone.relay.list(phone.box.toCli)).toEqual([]); // hello cleaned up
  });

  test("a hello sealed with another secret is ignored", async () => {
    const session = beginPairing(RELAY_URL, fetcher);
    const real = new Phone(session.qrText);
    const impostor = new Phone(beginPairing(RELAY_URL, fetcher).qrText);
    await real.relay.put(real.box.toCli, MESSAGE_IDS.hello, sealHello(impostor.offer.secret, { v: 1, encKey: impostor.id.encPublicKey, signKey: impostor.id.signPublicKey, name: "Impostor", at: "" }));
    expect(await session.poll()).toBeUndefined();
  });

  test("forget removes the keys and the record", async () => {
    await pairPhone();
    await forgetPairing();
    expect(await loadPairing()).toBeUndefined();
    expect(keychain.size).toBe(0);
  });
});

describe("approvals through the phone", () => {
  test("approve from the phone rotates the key", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    const snap = await phone.snapshot();
    expect(snap.requests[0]).toMatchObject({ id: request.id, resource: "openai", message: "We think this key may be exposed" });
    expect(snap.keys).toEqual([expect.objectContaining({ name: "openai", status: "active" })]);
    await phone.answer(request.id, "approve");
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, result: "rotated" }]);
    expect(rotated).toEqual(["openai"]);
    expect((await approvals.find(root, request.id)).decidedBy).toBe("phone");
  });

  test("deny from the phone leaves the key alone", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "expired");
    await push(root, link);
    await phone.answer(request.id, "deny");
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, result: "denied" }]);
    expect(rotated).toEqual([]);
  });

  test("a replayed approval is refused", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    const blob = await phone.answer(request.id, "approve");
    await poll(root, link, async () => {
      throw new Error("provider down");
    });
    expect((await approvals.find(root, request.id)).status).toBe("failed"); // still retryable
    await phone.relay.put(phone.box.toCli, messageId(), blob); // the relay replays the old approval
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, rejected: "stale or reused challenge" }]);
    expect(rotated).toEqual([]);
    await push(root, link); // a fresh challenge lets the person approve the retry
    await phone.answer(request.id, "approve");
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, result: "rotated" }]);
  });

  test("a forged signature is refused", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    await phone.answer(request.id, "approve", createPhoneIdentity().signSecretKey);
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, rejected: "bad signature" }]);
    expect((await approvals.find(root, request.id)).status).toBe("pending");
  });

  test("a relay can't inject a message it didn't get from the phone", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    const bogus = seal(new Uint8Array(32), AAD.toCli, { requestId: request.id, decision: "approve" });
    await phone.relay.put(phone.box.toCli, messageId(), bogus);
    expect(await poll(root, link, rotate)).toEqual([]);
    expect(await phone.relay.list(phone.box.toCli)).toEqual([]);
    expect(rotated).toEqual([]);
  });

  test("a decision signed for another pairing is refused", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    await phone.answer(request.id, "approve", undefined, { pairingId: "0".repeat(32) });
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, rejected: "signed for another pairing" }]);
  });

  test("a phone from an earlier pairing can't answer after re-pairing", async () => {
    const first = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, first.link);
    const old = first.phone;
    const second = await pairPhone();
    await push(root, second.link);
    // The old phone signs with its key and posts to the new pairing's box: the CLI can't even open it.
    const r = (await second.phone.snapshot()).requests[0]!;
    const signed = signDecision(old.id.signSecretKey, { pairingId: second.phone.box.pairingId, requestId: r.id, resource: r.resource, decision: "approve", challenge: r.challenge, issuedAt: new Date().toISOString() });
    await second.phone.relay.put(second.phone.box.toCli, messageId(), seal(old.key, AAD.toCli, signed));
    expect(await poll(root, second.link, rotate)).toEqual([]);
    // And sealed correctly by the new phone, the old key's signature still fails.
    await second.phone.relay.put(second.phone.box.toCli, messageId(), seal(second.phone.key, AAD.toCli, signed));
    expect(await poll(root, second.link, rotate)).toEqual([{ requestId: request.id, rejected: "bad signature" }]);
    expect(rotated).toEqual([]);
  });

  test("the relay only ever holds ciphertext", async () => {
    const { phone, link } = await pairPhone();
    await requestRotation(root, "openai", "exposed");
    await push(root, link);
    const stored = JSON.stringify(await phone.relay.list(phone.box.toPhone));
    for (const leak of ["openai", "exposed", "OPENAI_API_KEY", root]) expect(stored).not.toContain(leak);
  });
});

describe("challenge and pairing state", () => {
  test("a push running alongside a poll can't bring a consumed challenge back", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    const blob = await phone.answer(request.id, "deny");
    await Promise.all([poll(root, link, rotate), push(root, link), push(root, link)]);
    expect((await approvals.find(root, request.id)).status).toBe("denied");
    await phone.relay.put(phone.box.toCli, messageId(), blob); // replayed
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, rejected: "stale or reused challenge" }]);
    const relayState = await Bun.file(path.join(root, ".sikrets/relay.json")).json();
    expect(relayState.challenges[request.id]).toMatchObject({ status: "used" }); // kept as a tombstone
  });

  test("an answer for a request denied on the laptop meanwhile is reported as such, not as failed", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    await phone.answer(request.id, "approve");
    await applyEvent(root, request.id, "deny", { by: "cli" });
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, rejected: "already denied" }]);
    expect(rotated).toEqual([]);
  });

  test("a failed rotation gets a fresh challenge and can be denied from the phone", async () => {
    const { phone, link } = await pairPhone();
    const { request } = await requestRotation(root, "openai", "exposed");
    await push(root, link);
    await phone.answer(request.id, "approve");
    expect(await poll(root, link, async () => { throw new Error("provider down"); })).toEqual([{ requestId: request.id, result: "failed" }]);
    await push(root, link);
    expect((await phone.snapshot()).requests[0]).toMatchObject({ status: "failed", challenge: expect.any(String) });
    await phone.answer(request.id, "deny");
    expect(await poll(root, link, rotate)).toEqual([{ requestId: request.id, result: "denied" }]);
  });

  test("re-pairing that dies before the record is swapped keeps the old pairing working", async () => {
    const first = await pairPhone();
    const session = beginPairing(RELAY_URL, fetcher);
    // The new pairing's keychain slot was written, then the process died before pairing.json moved.
    keychain.set(`dev.sikrets.pairing/default-${"f".repeat(32)}`, JSON.stringify({ cliSecretKey: "x", pairSecret: decodeOffer(session.qrText).secret }));
    const link = (await loadLink(fetcher))!;
    expect(link.pairing.pairingId).toBe(first.phone.box.pairingId);
    expect(link.key).toEqual(first.phone.key);
    // Finishing a pairing replaces the record and drops the old slot.
    const second = await pairPhone();
    expect((await loadLink(fetcher))!.key).toEqual(second.phone.key);
    expect([...keychain.keys()]).not.toContain(`dev.sikrets.pairing/default-${first.phone.box.pairingId}`);
  });

  test("unpairing on the phone unpairs the laptop too, and the other way round", async () => {
    const { phone, link } = await pairPhone();
    const notice: UnpairNotice = { v: 1, pairingId: phone.box.pairingId, at: new Date().toISOString() };
    await phone.relay.put(phone.box.toCli, MESSAGE_IDS.unpaired, seal(phone.key, AAD.toCli, notice));
    await expect(poll(root, link, rotate)).rejects.toBeInstanceOf(PhoneUnpairedError);
    expect(await loadPairing()).toBeUndefined();
    expect(keychain.size).toBe(0);

    const again = await pairPhone();
    await forgetPairing({ fetcher });
    const sent = (await again.phone.relay.list(again.phone.box.toPhone)).find((m) => m.id === MESSAGE_IDS.unpaired)!;
    expect(open<UnpairNotice>(again.phone.key, AAD.toPhone, sent.blob).pairingId).toBe(again.phone.box.pairingId);
  });
});
