import { createHash, randomBytes } from "node:crypto";
import { DEVICE_AUTH } from "../constants.ts";

// Proof of possession for every request, in the style of DPoP (RFC 9449): a compact JWS signed by
// the device key over the method, the URL, the time, a one-time nonce and a hash of the body. A
// proof is useless for any other request, after the clock window, or a second time. Its header
// names the registered device (kid), or carries the public key itself (jwk) while registering.
// The server checks it in packages/server/src/proof.ts; the CLI's end-to-end tests run both.

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

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

export const bodyHash = (body: string | Uint8Array = "") => createHash("sha256").update(body).digest("base64url");

export function normalizeUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}${u.search}`;
}

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
