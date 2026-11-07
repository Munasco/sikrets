import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { AAD, CHALLENGE_BYTES, CLOCK_SKEW_MS, DECISION_CONTEXT, DECISION_MAX_AGE_MS, KEY_BYTES, LABELS, NONCE_BYTES, OFFER_PREFIX, PROTOCOL_VERSION } from "./constants.ts";

export * from "./constants.ts";

// Pairing a phone with the CLI, and everything they send each other through the relay.
//
//   laptop                         QR code                          phone
//   X25519 keypair, pairSecret ──▶ {relay, cli public key, secret} ─▶ X25519 + Ed25519 keypairs
//                                                                    hello (sealed with a key from
//   learns the phone's keys   ◀── relay box "to-cli" ◀──────────────  the secret): its public keys
//
// After the hello both sides hold the session key HKDF(X25519(cli, phone), salt = pairSecret), and
// every relay message is XChaCha20-Poly1305 under it. The relay only ever sees box ids (derived from
// the secret, so they reveal nothing) and ciphertext. Approvals are additionally Ed25519-signed by
// the phone over the request id, a one-time challenge and the decision; the CLI checks that
// signature itself, so a relay (or anyone holding ciphertext) can't approve anything.

export type Bytes = Uint8Array;

export const b64 = {
  encode: (b: Bytes) => base64urlnopad.encode(b),
  decode: (s: string) => base64urlnopad.decode(s),
};

/** UTF-8 decode without TextDecoder, which not every React Native runtime ships. */
export function utf8(bytes: Bytes): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

const derive = (ikm: Bytes, salt: Bytes | undefined, label: string, len = KEY_BYTES) => hkdf(sha256, ikm, salt, utf8ToBytes(label), len);

// ── Offer (what the QR code carries) ───────────────────────────────────────

export interface Offer {
  v: typeof PROTOCOL_VERSION;
  /** Base URL of the relay mailbox. */
  relay: string;
  /** The CLI's X25519 public key. */
  cliKey: string;
  /** 32 random bytes known only to the laptop and whoever scans the code. */
  secret: string;
}

export interface CliPairingSecrets {
  /** The CLI's X25519 secret key. */
  cliSecretKey: string;
  pairSecret: string;
}

export function createOffer(relay: string): { offer: Offer; secrets: CliPairingSecrets } {
  const sk = x25519.utils.randomSecretKey();
  const pairSecret = randomBytes(KEY_BYTES);
  return {
    offer: { v: PROTOCOL_VERSION, relay, cliKey: b64.encode(x25519.getPublicKey(sk)), secret: b64.encode(pairSecret) },
    secrets: { cliSecretKey: b64.encode(sk), pairSecret: b64.encode(pairSecret) },
  };
}

export const encodeOffer = (offer: Offer) => OFFER_PREFIX + b64.encode(utf8ToBytes(JSON.stringify(offer)));

export function decodeOffer(text: string): Offer {
  if (!text.startsWith(OFFER_PREFIX)) throw new Error("Not a Sikrets pairing code");
  let offer: Offer;
  try {
    offer = JSON.parse(utf8(b64.decode(text.slice(OFFER_PREFIX.length))));
  } catch {
    throw new Error("Pairing code is damaged");
  }
  if (offer.v !== PROTOCOL_VERSION) throw new Error(`Pairing code is version ${offer.v}; this app speaks ${PROTOCOL_VERSION}`);
  if (!/^https?:\/\//.test(offer.relay)) throw new Error("Pairing code has no relay URL");
  if (b64.decode(offer.cliKey).length !== KEY_BYTES || b64.decode(offer.secret).length !== KEY_BYTES) throw new Error("Pairing code is damaged");
  return offer;
}

// ── Ids derived from the pairing secret ────────────────────────────────────

export interface Mailbox {
  /** Opaque id both sides sign over; never sent to the relay. */
  pairingId: string;
  /** Relay box the CLI writes and the phone reads. */
  toPhone: string;
  /** Relay box the phone writes and the CLI reads. */
  toCli: string;
}

export function mailbox(pairSecret: string): Mailbox {
  const s = b64.decode(pairSecret);
  const id = (label: string) => bytesToHex(derive(s, undefined, label, 16));
  return { pairingId: id(LABELS.pairingId), toPhone: id(LABELS.boxToPhone), toCli: id(LABELS.boxToCli) };
}

// ── Sealing ────────────────────────────────────────────────────────────────

/** Encrypts a JSON value: base64url(nonce ‖ ciphertext). */
export function seal(key: Bytes, aad: string, value: unknown): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(key, nonce, utf8ToBytes(aad)).encrypt(utf8ToBytes(JSON.stringify(value)));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return b64.encode(out);
}

/** Decrypts and parses, throwing if the blob was made with another key or for another direction. */
export function open<T = unknown>(key: Bytes, aad: string, blob: string): T {
  const raw = b64.decode(blob);
  if (raw.length <= NONCE_BYTES) throw new Error("Message too short");
  const pt = xchacha20poly1305(key, raw.subarray(0, NONCE_BYTES), utf8ToBytes(aad)).decrypt(raw.subarray(NONCE_BYTES));
  return JSON.parse(utf8(pt)) as T;
}

export const helloKey = (pairSecret: string) => derive(b64.decode(pairSecret), undefined, LABELS.hello);

/** The key every message after the hello is sealed with. Same on both sides. */
export const sessionKey = (mySecretKey: string, theirPublicKey: string, pairSecret: string) =>
  derive(x25519.getSharedSecret(b64.decode(mySecretKey), b64.decode(theirPublicKey)), b64.decode(pairSecret), LABELS.session);

// ── Phone identity and hello ───────────────────────────────────────────────

export interface PhoneIdentity {
  encSecretKey: string;
  encPublicKey: string;
  /** Kept behind biometrics on the phone. */
  signSecretKey: string;
  signPublicKey: string;
}

export function createPhoneIdentity(): PhoneIdentity {
  const enc = x25519.utils.randomSecretKey();
  const sign = ed25519.utils.randomSecretKey();
  return {
    encSecretKey: b64.encode(enc),
    encPublicKey: b64.encode(x25519.getPublicKey(enc)),
    signSecretKey: b64.encode(sign),
    signPublicKey: b64.encode(ed25519.getPublicKey(sign)),
  };
}

export interface Hello {
  v: typeof PROTOCOL_VERSION;
  encKey: string;
  signKey: string;
  /** Shown on the laptop so the person can tell which phone paired. */
  name: string;
  at: string;
}

export const sealHello = (pairSecret: string, hello: Hello) => seal(helloKey(pairSecret), AAD.hello, hello);

export function openHello(pairSecret: string, blob: string): Hello {
  const hello = open<Hello>(helloKey(pairSecret), AAD.hello, blob);
  if (hello.v !== PROTOCOL_VERSION) throw new Error("Unsupported hello version");
  if (b64.decode(hello.encKey).length !== KEY_BYTES || b64.decode(hello.signKey).length !== KEY_BYTES) throw new Error("Hello carries bad keys");
  return hello;
}

/** Sent by whichever side unpairs, so the other one stops showing or accepting a dead pairing. */
export interface UnpairNotice {
  v: typeof PROTOCOL_VERSION;
  pairingId: string;
  at: string;
}

// ── What the CLI shows the phone ───────────────────────────────────────────

export type ReasonCategory = "exposed" | "expired" | "requested";

export interface RequestView {
  id: string;
  resource: string;
  reason: ReasonCategory;
  /** Generic wording only, never where a detection came from. */
  message: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  /** One-time value the phone must sign; empty once used or when the request is closed. */
  challenge: string;
}

export interface KeyView {
  name: string;
  provider: string;
  recipe: string;
  status: "active" | "not applied" | "rotation due";
  rotateBy?: string;
  lastRotatedAt?: string;
}

export interface Snapshot {
  v: typeof PROTOCOL_VERSION;
  seq: number;
  sentAt: string;
  project: string;
  requests: RequestView[];
  keys: KeyView[];
}

export const newChallenge = () => b64.encode(randomBytes(CHALLENGE_BYTES));

// ── Signed decisions ───────────────────────────────────────────────────────

export interface Decision {
  v: typeof PROTOCOL_VERSION;
  pairingId: string;
  requestId: string;
  resource: string;
  decision: "approve" | "deny";
  challenge: string;
  issuedAt: string;
}

export interface SignedDecision extends Decision {
  sig: string;
}

/** The exact bytes signed. A JSON array, so no field can bleed into the next. */
export const decisionBytes = (d: Decision) =>
  utf8ToBytes(JSON.stringify([DECISION_CONTEXT, d.v, d.pairingId, d.requestId, d.resource, d.decision, d.challenge, d.issuedAt]));

export function signDecision(signSecretKey: string, d: Omit<Decision, "v">): SignedDecision {
  const decision: Decision = { v: PROTOCOL_VERSION, ...d };
  return { ...decision, sig: b64.encode(ed25519.sign(decisionBytes(decision), b64.decode(signSecretKey))) };
}

/** What the CLI expects a decision to be about: its own record, not anything the message claims. */
export interface Expected {
  pairingId: string;
  requestId: string;
  resource: string;
  challenge: string;
  expiresAt: string;
}

export type Verdict = { ok: true; decision: "approve" | "deny" } | { ok: false; why: string };

/** Checks a decision against the paired phone's key and the CLI's own record of the request. */
export function verifyDecision(phoneSignKey: string, d: SignedDecision, expected: Expected, now = Date.now()): Verdict {
  let valid = false;
  try {
    valid = ed25519.verify(b64.decode(d.sig), decisionBytes(d), b64.decode(phoneSignKey));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, why: "bad signature" };
  if (d.v !== PROTOCOL_VERSION) return { ok: false, why: "unsupported version" };
  if (d.decision !== "approve" && d.decision !== "deny") return { ok: false, why: "unknown decision" };
  if (d.pairingId !== expected.pairingId) return { ok: false, why: "signed for another pairing" };
  if (d.requestId !== expected.requestId || d.resource !== expected.resource) return { ok: false, why: "signed for another request" };
  if (!sameString(d.challenge, expected.challenge)) return { ok: false, why: "stale or reused challenge" };
  const issued = Date.parse(d.issuedAt);
  if (!Number.isFinite(issued) || issued > now + CLOCK_SKEW_MS) return { ok: false, why: "issued in the future" };
  if (now - issued > DECISION_MAX_AGE_MS) return { ok: false, why: "decision too old" };
  if (now >= Date.parse(expected.expiresAt)) return { ok: false, why: "request expired" };
  return { ok: true, decision: d.decision };
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Random id for a relay message. */
export const messageId = () => bytesToHex(randomBytes(12));
export * from "./relay.ts";
