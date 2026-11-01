import { randomBytes } from "node:crypto";

// Shamir secret sharing over GF(256), byte by byte: any `threshold` shares rebuild the secret and
// fewer reveal nothing about it. Used to split a recovery code between the owner and emergency
// contacts (2-of-3 by default). Share x-coordinates are 1..n; x = 0 is the secret.

export interface Share {
  x: number;
  y: Uint8Array;
}

// Log/antilog tables for the AES field (x^8 + x^4 + x^3 + x + 1), generator 3.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, v = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = v;
  LOG[v] = i;
  v ^= (v << 1) ^ (v & 0x80 ? 0x11b : 0); // v *= 3
}

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);
const div = (a: number, b: number) => (a ? EXP[LOG[a]! + 255 - LOG[b]!]! : 0);

export function split(secret: Uint8Array, shares: number, threshold: number): Share[] {
  if (threshold < 2 || threshold > shares || shares > 255) throw new Error("Need 2 ≤ threshold ≤ shares ≤ 255");
  const coeffs = Array.from(secret, (s) => [s, ...randomBytes(threshold - 1)]);
  return Array.from({ length: shares }, (_, i) => {
    const x = i + 1;
    // Horner's rule, highest coefficient first.
    return { x, y: Uint8Array.from(coeffs, (c) => c.reduceRight((acc, a) => mul(acc, x) ^ a, 0)) };
  });
}

/** Lagrange interpolation at x = 0. Garbage in, garbage out: callers check the result. */
export function combine(shares: readonly Share[]): Uint8Array {
  const xs = shares.map((s) => s.x);
  if (new Set(xs).size !== xs.length) throw new Error("Those are copies of the same share; use two different ones");
  const len = shares[0]!.y.length;
  if (shares.some((s) => s.y.length !== len)) throw new Error("Those shares come from different splits");
  const out = new Uint8Array(len);
  for (const [i, si] of shares.entries()) {
    // Basis polynomial for share i evaluated at 0: Π x_j / (x_j - x_i); subtraction is XOR.
    let basis = 1;
    for (const [j, sj] of shares.entries()) if (i !== j) basis = mul(basis, div(sj.x, sj.x ^ si.x));
    for (let b = 0; b < len; b++) out[b]! ^= mul(si.y[b]!, basis);
  }
  return out;
}
