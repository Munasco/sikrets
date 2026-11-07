import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { configDir, keychain } from "../store.ts";
import { withLock } from "./lock.ts";
import { RECOVERY } from "../constants.ts";

// The vault data key: one random 256-bit key per user, kept in the OS keychain. It is the single
// key that client-side encryption hangs off, so it is also the one thing recovery has to protect.
// seal/open are AES-256-GCM with a fresh IV per value; the server only ever sees their output.

const { dataKeyProvider: PROVIDER, dataKeyAccount: ACCOUNT } = RECOVERY;

export interface Sealed {
  iv: string;
  ct: string;
  tag: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

export async function loadDataKey(): Promise<Buffer | undefined> {
  const stored = await keychain.get(PROVIDER, ACCOUNT);
  return stored ? unb64(stored) : undefined;
}

export const saveDataKey = (key: Uint8Array) => keychain.set(PROVIDER, ACCOUNT, b64(key));

/**
 * Creates this device's data key on first use. Under a lock, so two first runs at once can't each
 * make a key and leave values sealed under the one that lost.
 */
export async function ensureDataKey(): Promise<Buffer> {
  return withLock(path.join(configDir(), RECOVERY.dataKeyLock), async () => {
    const existing = await loadDataKey();
    if (existing) return existing;
    const key = randomBytes(RECOVERY.dataKeyBytes);
    await saveDataKey(key);
    return key;
  });
}

/** Identifies a data key without revealing it, so restore can tell whether two devices share one. */
export const fingerprint = (key: Uint8Array) => createHash("sha256").update(RECOVERY.fingerprintLabel).update(key).digest("hex").slice(0, 16);

export const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Sealed {
  const iv = randomBytes(RECOVERY.ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(cipher.getAuthTag()) };
}

/** Throws if the key is wrong or anything was tampered with; GCM never returns garbage. */
export function open(key: Uint8Array, sealed: Sealed, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(sealed.iv)).setAAD(Buffer.from(aad));
  decipher.setAuthTag(unb64(sealed.tag));
  return Buffer.concat([decipher.update(unb64(sealed.ct)), decipher.final()]);
}
