import { createHmac } from "node:crypto";
import { Secret } from "../secret.ts";
import { TOTP } from "../../constants.ts";

// Time-based one-time codes (RFC 6238, on HOTP from RFC 4226). The secret comes from an
// otpauth:// URI (what an authenticator QR code holds) or a bare base32 key. Codes are generated
// only at the moment of filling and go straight into the page.

export type TotpAlgorithm = (typeof TOTP.algorithms)[number];

export interface TotpConfig {
  readonly key: Uint8Array;
  readonly digits: number;
  readonly period: number;
  readonly algorithm: TotpAlgorithm;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error("The TOTP secret isn't valid base32");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (!out.length) throw new Error("The TOTP secret is empty");
  return Uint8Array.from(out);
}

/** Parses an otpauth://totp/… URI or a bare base32 secret. Errors never quote the input. */
export function parseTotp(secret: Secret): TotpConfig {
  const raw = secret.reveal().trim();
  if (!raw.toLowerCase().startsWith(TOTP.scheme)) return { key: base32Decode(raw), digits: TOTP.digits, period: TOTP.period, algorithm: TOTP.algorithm };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The otpauth:// URI is malformed");
  }
  if (url.host.toLowerCase() !== "totp") throw new Error("Only time-based (otpauth://totp/…) codes are supported");
  const key = url.searchParams.get("secret");
  if (!key) throw new Error("The otpauth:// URI has no secret");
  const algorithm = (url.searchParams.get("algorithm") ?? TOTP.algorithm).toUpperCase();
  if (!(TOTP.algorithms as readonly string[]).includes(algorithm)) throw new Error(`Unsupported TOTP algorithm ${algorithm}`);
  const digits = Number(url.searchParams.get("digits") ?? TOTP.digits);
  const period = Number(url.searchParams.get("period") ?? TOTP.period);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error("TOTP digits must be 6 to 10");
  if (!Number.isInteger(period) || period < 1) throw new Error("TOTP period must be a positive number of seconds");
  return { key: base32Decode(key), digits, period, algorithm: algorithm as TotpAlgorithm };
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(key: Uint8Array, counter: number, digits: number, algorithm: TotpAlgorithm): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** The code valid at `nowMs`, wrapped so it can't be logged by accident. */
export function totpCode(config: TotpConfig, nowMs = Date.now()): Secret {
  return Secret.of(hotp(config.key, Math.floor(nowMs / 1000 / config.period), config.digits, config.algorithm));
}
