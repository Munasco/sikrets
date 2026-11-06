import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { keychain } from "../store.ts";
import { deviceDir, thisDevice, type DataKeyWrap } from "./device.ts";
import { readJson, remove, writePrivate } from "./fs.ts";
import { DEVICE, RECOVERY } from "../constants.ts";

// The vault data key: one random 256-bit key per user. It is the single key that client-side
// encryption hangs off, so it is also the one thing recovery has to protect. On each device it is
// stored wrapped to that device's key-agreement key (see device.ts), so the file is useless
// anywhere else. seal/open are AES-256-GCM with a fresh IV per value; the server only ever sees
// their output.
//
// Earlier versions kept the key raw in the OS keychain. The first load wraps it, checks the wrap
// opens to the same key, and only then deletes the raw copy.

const { dataKeyProvider: PROVIDER, dataKeyAccount: ACCOUNT } = RECOVERY;

export interface Sealed {
  iv: string;
  ct: string;
  tag: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

export const dataKeyFile = () => path.join(deviceDir(), DEVICE.dataKeyFile);

const readWrapped = () => readJson<DataKeyWrap | undefined>(dataKeyFile(), undefined);

/** Throws DeviceMismatchError when the wrapped key on disk belongs to another device. */
export async function loadDataKey(): Promise<Buffer | undefined> {
  const wrapped = await readWrapped();
  if (wrapped) return (await thisDevice()).unwrap(wrapped);
  const raw = await keychain.get(PROVIDER, ACCOUNT);
  if (!raw) return undefined;
  const key = unb64(raw);
  // Best effort: if this device can't hold keys right now, keep using the raw copy and retry next time.
  await saveDataKey(key).catch(() => {});
  return key;
}

/** Wraps the key to this device and removes any raw keychain copy, once the wrap is proven to open. */
export async function saveDataKey(key: Uint8Array) {
  const device = await thisDevice();
  const wrapped = device.wrap(key, fingerprint(key));
  if (!sameKey(await device.unwrap(wrapped), key)) throw new Error("Wrapping the data key for this device didn't round-trip; nothing changed");
  await writePrivate(dataKeyFile(), JSON.stringify(wrapped, null, 2) + "\n");
  if (await keychain.get(PROVIDER, ACCOUNT)) await keychain.delete(PROVIDER, ACCOUNT);
}

/** Drops this device's wrapped copy (restore --force replaces it). */
export const forgetDataKey = () => remove(dataKeyFile());

/** Creates this device's data key on first use. */
export async function ensureDataKey(): Promise<Buffer> {
  const existing = await loadDataKey();
  if (existing) return existing;
  const key = randomBytes(RECOVERY.dataKeyBytes);
  await saveDataKey(key);
  return key;
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
