import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { DEVICE_AUTH } from "../constants.ts";

// Proof of possession for every request, in the style of DPoP (RFC 9449): a compact JWS signed by
// the device key over the method, the URL, the time, a one-time nonce and a hash of the body. A
// proof is useless for any other request, after the clock window, or a second time. Its header
// names the registered device (kid), or carries the public key itself (jwk) while registering.
// The server side (verifyProof) lives here too so the client and the fake server can't drift.

export interface ProofHeader {
  typ: string;
  alg: string;
  /** The device id, once registered. */
  kid?: string;
  /** The public key, while registering (proves the caller holds the key it is registering). */
  jwk?: JsonWebKey;
}

export interface ProofClaims {
  /** HTTP method. */
  htm: string;
  /** URL without fragment (query included, so it can't be changed either). */
  htu: string;
  /** Seconds since the epoch. */
  iat: number;
  /** One-time nonce. */
  jti: string;
  /** base64url SHA-256 of the exact body bytes ("" when there is none). */
  bh: string;
}

export type Signer = (data: Uint8Array) => Promise<Buffer>;

export class ProofError extends Error {
  constructor(readonly reason: string) {
    super(`Rejected proof: ${reason}`);
  }
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export const bodyHash = (body: string | Uint8Array = "") => createHash("sha256").update(body).digest("base64url");

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}${u.search}`;
}

/** RFC 7638 thumbprint of a P-256 public key. */
export const jwkThumbprint = (jwk: JsonWebKey) => createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");

/** A compact ES256 JWS; the signer returns raw r||s, which is what JWS wants. */
export async function signJws(sign: Signer, header: object, payload: object): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(await sign(Buffer.from(input)))}`;
}

export interface ProofRequest {
  method: string;
  url: string;
  body?: string | Uint8Array;
}

export function createProof(sign: Signer, req: ProofRequest, who: { kid: string } | { jwk: JsonWebKey }, opts: { now?: number; nonce?: string } = {}): Promise<string> {
  const header: ProofHeader = { typ: DEVICE_AUTH.proofType, alg: DEVICE_AUTH.alg, ...who };
  const claims: ProofClaims = {
    htm: req.method.toUpperCase(),
    htu: normalizeUrl(req.url),
    iat: Math.floor((opts.now ?? Date.now()) / 1000),
    jti: opts.nonce ?? randomBytes(DEVICE_AUTH.nonceBytes).toString("base64url"),
    bh: bodyHash(req.body),
  };
  return signJws(sign, header, claims);
}

/** Nonces seen within their lifetime; anything older is rejected as stale before it gets here. */
export class NonceStore {
  private readonly seen = new Map<string, number>();

  /** False when the nonce was already used. Remembers it otherwise. */
  claim(jti: string, nowSeconds: number): boolean {
    for (const [n, until] of this.seen) if (until < nowSeconds) this.seen.delete(n);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, nowSeconds + DEVICE_AUTH.nonceTtlSeconds);
    return true;
  }
}

export interface VerifyOptions extends ProofRequest {
  nonces: NonceStore;
  now?: number;
  /** The key to check against: the registered device's for a kid (throw ProofError if revoked), or the header's own jwk. */
  keyFor(header: ProofHeader): JsonWebKey;
}

/** Checks a proof against the request the server actually received. Throws ProofError with the reason. */
export function verifyProof(proof: string | null | undefined, opts: VerifyOptions): { header: ProofHeader; claims: ProofClaims } {
  if (!proof) throw new ProofError("missing");
  const parts = proof.split(".");
  if (parts.length !== 3) throw new ProofError("malformed");
  let header: ProofHeader;
  let claims: ProofClaims;
  try {
    [header, claims] = [json(parts[0]!), json(parts[1]!)];
  } catch {
    throw new ProofError("malformed");
  }
  if (header.typ !== DEVICE_AUTH.proofType || header.alg !== DEVICE_AUTH.alg) throw new ProofError("wrong type or algorithm");
  if (typeof claims.jti !== "string" || !claims.jti || typeof claims.iat !== "number") throw new ProofError("malformed");

  const jwk = opts.keyFor(header);
  let ok = false;
  try {
    ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) throw new ProofError("bad signature");

  if (claims.htm !== opts.method.toUpperCase()) throw new ProofError("wrong method");
  if (claims.htu !== normalizeUrl(opts.url)) throw new ProofError("wrong URL");
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - claims.iat) > DEVICE_AUTH.clockSkewSeconds) throw new ProofError("stale");
  if (claims.bh !== bodyHash(opts.body)) throw new ProofError("body doesn't match");
  if (!opts.nonces.claim(claims.jti, now)) throw new ProofError("replayed");
  return { header, claims };
}
