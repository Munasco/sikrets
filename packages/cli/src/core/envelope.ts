import { hkdfSync } from "node:crypto";
import { open, seal } from "./datakey.ts";
import { ENVELOPE } from "../constants.ts";

// The format a vault value is stored in: `sk1:<base64 iv|ciphertext|tag>`, AES-256-GCM under the
// project's key (derived from the data key), with the value's project and key name bound in as
// associated data. A ciphertext copied to another key or project fails to open instead of
// decrypting to the wrong secret. Errors name the key, never the value.

export class EnvelopeError extends Error {}

/** One project's key. Every device holding the same data key derives the same one. */
export const projectKey = (dataKey: Uint8Array, project: string) =>
  Buffer.from(hkdfSync("sha256", dataKey, ENVELOPE.hkdfSalt, ENVELOPE.hkdfInfo(project), 32));

/** "sealed" for this version, "newer" for one this build can't read, "plain" for legacy values. */
export function envelopeKind(stored: string): "sealed" | "newer" | "plain" {
  if (stored.startsWith(ENVELOPE.prefix)) return "sealed";
  return ENVELOPE.versionPattern.test(stored) ? "newer" : "plain";
}

export function sealValue(key: Uint8Array, project: string, name: string, plaintext: string): string {
  const s = seal(key, Buffer.from(plaintext, "utf8"), ENVELOPE.aad(project, name));
  const raw = Buffer.concat([Buffer.from(s.iv, "base64"), Buffer.from(s.ct, "base64"), Buffer.from(s.tag, "base64")]);
  return ENVELOPE.prefix + raw.toString("base64");
}

export function openValue(key: Uint8Array, project: string, name: string, stored: string): string {
  const kind = envelopeKind(stored);
  if (kind === "newer") throw new EnvelopeError(`${name} was written by a newer Sikrets; update the CLI to read it`);
  if (kind === "plain") throw new EnvelopeError(`${name} isn't encrypted`);
  const raw = Buffer.from(stored.slice(ENVELOPE.prefix.length), "base64");
  if (raw.length < ENVELOPE.ivBytes + ENVELOPE.tagBytes) throw new EnvelopeError(`${name} is corrupt`);
  const b64 = (b: Buffer) => b.toString("base64");
  const sealed = {
    iv: b64(raw.subarray(0, ENVELOPE.ivBytes)),
    ct: b64(raw.subarray(ENVELOPE.ivBytes, raw.length - ENVELOPE.tagBytes)),
    tag: b64(raw.subarray(raw.length - ENVELOPE.tagBytes)),
  };
  try {
    return open(key, sealed, ENVELOPE.aad(project, name)).toString("utf8");
  } catch {
    throw new EnvelopeError(`Can't decrypt ${name}: it was sealed with a different data key, for a different key or project, or changed after sealing`);
  }
}
