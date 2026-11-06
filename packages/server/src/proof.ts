import { createHash, createPublicKey, verify } from "node:crypto";
import { PROTOCOL } from "./constants.ts";

// Checking the proof every request carries (the client side is packages/cli/src/core/proof.ts): a
// compact ES256 JWS, in the style of DPoP (RFC 9449), signed by the device key over the method,
// the URL, the time, a one-time nonce and a hash of the body. A proof is refused for any other
// request, outside the clock window, or a second time. Its header names a registered device (kid)
// or, only while registering, carries the public key itself (jwk).

export interface ProofHeader {
  typ: string;
  alg: string;
  kid?: string;
  jwk?: JsonWebKey;
}

export interface ProofClaims {
  htm: string;
  htu: string;
  iat: number;
  jti: string;
  bh: string;
}

export class ProofError extends Error {
  constructor(readonly reason: string) {
    super(`Rejected proof: ${reason}`);
  }
}

const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export const bodyHash = (body: string = "") => createHash("sha256").update(body).digest("base64url");

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}${u.search}`;
}

/** RFC 7638 thumbprint of a P-256 public key. */
export const jwkThumbprint = (jwk: JsonWebKey) => createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");

/** A P-256 public key and nothing else (a jwk carrying a private part is refused outright). */
export const isPublicP256 = (jwk: unknown): jwk is JsonWebKey => {
  const k = jwk as JsonWebKey | undefined;
  return !!k && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" && k.d === undefined;
};

export interface VerifyOptions {
  method: string;
  /** The URL as the client addressed it (see config publicUrl). */
  url: string;
  body: string;
  /** Epoch milliseconds. */
  now: number;
  /** The key to check against: the registered device's for a kid, the header's own jwk while registering. Throws ProofError to refuse. */
  keyFor(header: ProofHeader): Promise<JsonWebKey>;
  /** Records the nonce; false when it was already used. */
  claimNonce(jti: string, expiresAt: number, now: number): Promise<boolean>;
}

/** Checks a proof against the request the server received. Throws ProofError with the reason. */
export async function verifyProof(proof: string | null | undefined, opts: VerifyOptions): Promise<{ header: ProofHeader; claims: ProofClaims }> {
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
  if (typeof header !== "object" || header === null || typeof claims !== "object" || claims === null) throw new ProofError("malformed");
  if (header.typ !== PROTOCOL.proofType || header.alg !== PROTOCOL.alg) throw new ProofError("wrong type or algorithm");
  if (typeof claims.jti !== "string" || !claims.jti || claims.jti.length > PROTOCOL.maxNonceChars || typeof claims.iat !== "number") throw new ProofError("malformed");

  const jwk = await opts.keyFor(header);
  let ok = false;
  try {
    ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) throw new ProofError("bad signature");

  if (claims.htm !== opts.method.toUpperCase()) throw new ProofError("wrong method");
  if (claims.htu !== normalizeUrl(opts.url)) throw new ProofError("wrong URL");
  const now = Math.floor(opts.now / 1000);
  if (Math.abs(now - claims.iat) > PROTOCOL.clockSkewSeconds) throw new ProofError("stale");
  if (claims.bh !== bodyHash(opts.body)) throw new ProofError("body doesn't match");
  // Claimed last, so a proof refused for anything else doesn't burn its nonce.
  if (!(await opts.claimNonce(claims.jti, now + PROTOCOL.nonceTtlSeconds, now))) throw new ProofError("replayed");
  return { header, claims };
}
