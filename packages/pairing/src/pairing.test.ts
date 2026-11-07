import { describe, expect, test } from "bun:test";
import {
  AAD,
  b64,
  createOffer,
  createPhoneIdentity,
  decodeOffer,
  encodeOffer,
  mailbox,
  newChallenge,
  open,
  openHello,
  seal,
  sealHello,
  sessionKey,
  signDecision,
  verifyDecision,
  utf8,
  type Expected,
} from "./index.ts";

const RELAY = "https://relay.example";

function paired() {
  const { offer, secrets } = createOffer(RELAY);
  const scanned = decodeOffer(encodeOffer(offer));
  const phone = createPhoneIdentity();
  const box = mailbox(scanned.secret);
  return { offer, secrets, phone, box };
}

describe("offer", () => {
  test("round-trips through the QR text", () => {
    const { offer } = createOffer(RELAY);
    expect(decodeOffer(encodeOffer(offer))).toEqual(offer);
  });

  test("rejects other codes and damaged ones", () => {
    expect(() => decodeOffer("https://example.com")).toThrow("Not a Sikrets pairing code");
    expect(() => decodeOffer("sikrets://pair#@@@")).toThrow("damaged");
  });

  test("every pairing gets fresh keys and ids", () => {
    const a = createOffer(RELAY);
    const b = createOffer(RELAY);
    expect(a.offer.cliKey).not.toBe(b.offer.cliKey);
    expect(mailbox(a.offer.secret).toCli).not.toBe(mailbox(b.offer.secret).toCli);
  });
});

describe("key exchange", () => {
  test("both sides derive the same session key", () => {
    const { offer, secrets, phone } = paired();
    const cli = sessionKey(secrets.cliSecretKey, phone.encPublicKey, secrets.pairSecret);
    const ph = sessionKey(phone.encSecretKey, offer.cliKey, offer.secret);
    expect(b64.encode(cli)).toBe(b64.encode(ph));
  });

  test("box ids don't reveal the pairing id or each other", () => {
    const { box } = paired();
    expect(new Set([box.pairingId, box.toCli, box.toPhone]).size).toBe(3);
    expect(box.toCli).toMatch(/^[0-9a-f]{32}$/);
  });

  test("hello carries the phone's public keys, sealed with the pairing secret", () => {
    const { secrets, offer, phone } = paired();
    const blob = sealHello(offer.secret, { v: 1, encKey: phone.encPublicKey, signKey: phone.signPublicKey, name: "iPhone", at: new Date().toISOString() });
    expect(blob).not.toContain(phone.signPublicKey);
    expect(openHello(secrets.pairSecret, blob).signKey).toBe(phone.signPublicKey);
    expect(() => openHello(createOffer(RELAY).secrets.pairSecret, blob)).toThrow();
  });

  test("sealed messages open only with the right key and direction", () => {
    const { offer, secrets, phone } = paired();
    const key = sessionKey(secrets.cliSecretKey, phone.encPublicKey, secrets.pairSecret);
    const blob = seal(key, AAD.toPhone, { hello: "phone" });
    expect(open<{ hello: string }>(sessionKey(phone.encSecretKey, offer.cliKey, offer.secret), AAD.toPhone, blob)).toEqual({ hello: "phone" });
    expect(() => open(key, AAD.toCli, blob)).toThrow();
    const stranger = createPhoneIdentity();
    expect(() => open(sessionKey(stranger.encSecretKey, offer.cliKey, offer.secret), AAD.toPhone, blob)).toThrow();
  });

  test("a tampered blob fails to open", () => {
    const { secrets, phone } = paired();
    const key = sessionKey(secrets.cliSecretKey, phone.encPublicKey, secrets.pairSecret);
    const raw = b64.decode(seal(key, AAD.toCli, { a: 1 }));
    raw[raw.length - 1]! ^= 1;
    expect(() => open(key, AAD.toCli, b64.encode(raw))).toThrow();
  });
});

describe("signed decisions", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  function setup() {
    const { phone, box } = paired();
    const expected: Expected = { pairingId: box.pairingId, requestId: "apr_1234", resource: "openai", challenge: newChallenge(), expiresAt: new Date(now + 3_600_000).toISOString() };
    const sign = (over: Partial<typeof expected> & { decision?: "approve" | "deny"; issuedAt?: string } = {}, key = phone.signSecretKey) =>
      signDecision(key, { pairingId: expected.pairingId, requestId: expected.requestId, resource: expected.resource, challenge: expected.challenge, decision: "approve", issuedAt: new Date(now).toISOString(), ...over });
    return { phone, expected, sign };
  }

  test("accepts a valid approval and a valid denial", () => {
    const { phone, expected, sign } = setup();
    expect(verifyDecision(phone.signPublicKey, sign(), expected, now)).toEqual({ ok: true, decision: "approve" });
    expect(verifyDecision(phone.signPublicKey, sign({ decision: "deny" }), expected, now)).toEqual({ ok: true, decision: "deny" });
  });

  test("rejects a forged signature (another key)", () => {
    const { phone, expected, sign } = setup();
    const forged = sign({}, createPhoneIdentity().signSecretKey);
    expect(verifyDecision(phone.signPublicKey, forged, expected, now)).toEqual({ ok: false, why: "bad signature" });
  });

  test("rejects a deny rewritten as an approve", () => {
    const { phone, expected, sign } = setup();
    const flipped = { ...sign({ decision: "deny" }), decision: "approve" as const };
    expect(verifyDecision(phone.signPublicKey, flipped, expected, now)).toEqual({ ok: false, why: "bad signature" });
  });

  test("rejects garbage in the signature field", () => {
    const { phone, expected, sign } = setup();
    expect(verifyDecision(phone.signPublicKey, { ...sign(), sig: "AAAA" }, expected, now).ok).toBe(false);
  });

  test("rejects a replay against a newer challenge", () => {
    const { phone, expected, sign } = setup();
    const old = sign();
    expect(verifyDecision(phone.signPublicKey, old, { ...expected, challenge: newChallenge() }, now)).toEqual({ ok: false, why: "stale or reused challenge" });
  });

  test("rejects a decision signed for another pairing", () => {
    const { phone, expected, sign } = setup();
    const other = sign({ pairingId: mailbox(createOffer(RELAY).offer.secret).pairingId });
    expect(verifyDecision(phone.signPublicKey, other, expected, now)).toEqual({ ok: false, why: "signed for another pairing" });
  });

  test("rejects a decision from another paired phone", () => {
    const { expected, sign } = setup();
    expect(verifyDecision(createPhoneIdentity().signPublicKey, sign(), expected, now)).toEqual({ ok: false, why: "bad signature" });
  });

  test("rejects a decision moved to another request", () => {
    const { phone, expected, sign } = setup();
    expect(verifyDecision(phone.signPublicKey, sign({ requestId: "apr_other" }), expected, now).ok).toBe(false);
    expect(verifyDecision(phone.signPublicKey, sign({ resource: "stripe" }), expected, now).ok).toBe(false);
  });

  test("rejects old, future-dated and expired decisions", () => {
    const { phone, expected, sign } = setup();
    expect(verifyDecision(phone.signPublicKey, sign({ issuedAt: new Date(now - 16 * 60_000).toISOString() }), expected, now)).toEqual({ ok: false, why: "decision too old" });
    expect(verifyDecision(phone.signPublicKey, sign({ issuedAt: new Date(now + 10 * 60_000).toISOString() }), expected, now)).toEqual({ ok: false, why: "issued in the future" });
    expect(verifyDecision(phone.signPublicKey, sign(), { ...expected, expiresAt: new Date(now - 1).toISOString() }, now)).toEqual({ ok: false, why: "request expired" });
  });
});

test("utf8 decodes like TextDecoder", () => {
  for (const s of ["plain", "café", "日本語", "🔑 key", ""]) expect(utf8(new TextEncoder().encode(s))).toBe(new TextDecoder().decode(new TextEncoder().encode(s)));
});
