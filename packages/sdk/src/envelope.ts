// Opens values the CLI sealed before writing them to SSM (`sk1:<base64 iv|ciphertext|tag>`, AES-256-GCM,
// the parameter name as associated data). Web Crypto only, so it runs in Node, Bun and edge
// runtimes alike. Values without the prefix are legacy plaintext and pass through unchanged.

import { DATA_KEY_KEYCHAIN, ENVELOPE } from "./constants.ts";

const utf8 = new TextEncoder();
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Web Crypto wants a plain ArrayBuffer-backed copy. */
const bytesOf = (b: Uint8Array) => new Uint8Array(b);

export const isSealed = (stored: string) => ENVELOPE.versionPattern.test(stored);

/** The project's AES key from its base64 project key (what `sikrets env pull --project-key` writes). */
export async function importProjectKey(raw: string | Uint8Array): Promise<CryptoKey> {
  const bytes = typeof raw === "string" ? fromBase64(raw.trim()) : bytesOf(raw);
  if (bytes.length !== 32) throw new Error("the project key must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]);
}

/** Derives the project key from the data key the same way the CLI does (HKDF-SHA256). */
export async function deriveProjectKey(dataKey: Uint8Array, project: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bytesOf(dataKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode(ENVELOPE.hkdfSalt), info: utf8.encode(ENVELOPE.hkdfInfo(project)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

/** Under Bun on a developer machine, the data key the CLI keeps in the OS keychain. */
export async function keychainDataKey(): Promise<Uint8Array | undefined> {
  const bun = (globalThis as { Bun?: { secrets: { get(o: { service: string; name: string }): Promise<string | null> } } }).Bun;
  const stored = bun ? await bun.secrets.get(DATA_KEY_KEYCHAIN) : null;
  return stored ? fromBase64(stored) : undefined;
}

/** Throws a message naming the parameter, never the value. */
export async function openSealed(key: CryptoKey, name: string, stored: string): Promise<string> {
  if (!stored.startsWith(ENVELOPE.prefix)) throw new Error("it was written by a newer Sikrets; update @sikrets/sdk");
  const raw = fromBase64(stored.slice(ENVELOPE.prefix.length));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, ENVELOPE.ivBytes), additionalData: utf8.encode(ENVELOPE.aad(name)) },
      key,
      raw.subarray(ENVELOPE.ivBytes),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(`can't decrypt ${name}: wrong project key, or the value was changed`);
  }
}
