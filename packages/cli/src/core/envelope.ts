import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { ENVELOPE } from "../constants.ts";

// Client-side encryption for values that leave this machine. Each value is sealed with AES-256-GCM
// under its project's key and written as `sk1:<base64 iv|ciphertext|tag>`. The full parameter
// name is bound in as associated data, so a ciphertext copied to another name (or project) fails
// to open. The vault only ever stores this string; KMS on top is defence in depth, not the lock.

export class EnvelopeError extends Error {}

/** One project's key, derived from the data key. Every device with the same data key derives the same one. */
export const projectKey = (dataKey: Uint8Array, project: string) =>
  Buffer.from(hkdfSync("sha256", dataKey, ENVELOPE.hkdfSalt, ENVELOPE.hkdfInfo(project), 32));

/** "sealed" for this version, "newer" for a version this build can't read, "plain" for legacy values. */
export function envelopeKind(stored: string): "sealed" | "newer" | "plain" {
  if (stored.startsWith(ENVELOPE.prefix)) return "sealed";
  return ENVELOPE.versionPattern.test(stored) ? "newer" : "plain";
}

export function sealValue(key: Uint8Array, name: string, plaintext: string): string {
  const iv = randomBytes(ENVELOPE.ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(ENVELOPE.aad(name)));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ENVELOPE.prefix + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}

/** Throws EnvelopeError on a wrong key, a moved value or any tampering. Messages name the parameter, never the value. */
export function openValue(key: Uint8Array, name: string, stored: string): string {
  const kind = envelopeKind(stored);
  if (kind === "newer") throw new EnvelopeError(`${name} was written by a newer Sikrets; update the CLI to read it`);
  if (kind === "plain") throw new EnvelopeError(`${name} isn't encrypted`);
  const raw = Buffer.from(stored.slice(ENVELOPE.prefix.length), "base64");
  if (raw.length < ENVELOPE.ivBytes + ENVELOPE.tagBytes) throw new EnvelopeError(`${name} is corrupt`);
  const iv = raw.subarray(0, ENVELOPE.ivBytes);
  const tag = raw.subarray(raw.length - ENVELOPE.tagBytes);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(ENVELOPE.aad(name)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(ENVELOPE.ivBytes, raw.length - ENVELOPE.tagBytes)), decipher.final()]).toString("utf8");
  } catch {
    throw new EnvelopeError(`Can't decrypt ${name}: it was sealed with a different data key, or changed after sealing`);
  }
}
