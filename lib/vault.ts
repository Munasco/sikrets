// Browser port of the Tennant CLI vault (cli/src/projects/vault.ts).
// The master key is wrapped with a password-derived KEK; Convex only ever sees ciphertext.

import type { VaultKey, VaultSecret } from "./api";

const subtle = globalThis.crypto.subtle;
const ITERATIONS = 600_000;
const FORMAT = "tennant-link-v1";

const toBytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000 || salt.length < 16 || salt.length > 64) {
    throw new Error("Unsupported vault key derivation parameters");
  }
  const material = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, { name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function createVaultKey(password: string) {
  if (password.length < 12) throw new Error("Use a vault password of at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kek = await derive(password, salt, ITERATIONS);
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return {
    wrappedMasterKey: toBase64(await subtle.wrapKey("raw", key, kek, "AES-KW")),
    kekSalt: toBase64(salt),
    kekIterations: ITERATIONS,
    algorithm: "AES-GCM-256",
  };
}

export async function unlockVault(wrapped: VaultKey, password: string) {
  if (wrapped.algorithm !== "AES-GCM-256") throw new Error("Unsupported vault encryption algorithm");
  const kek = await derive(password, toBytes(wrapped.kekSalt), wrapped.kekIterations);
  try {
    return await subtle.unwrapKey("raw", toBytes(wrapped.wrappedMasterKey), kek, "AES-KW", { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new Error("Incorrect vault password");
  }
}

type Identity = { key: string; environment: string; provider: string };

export async function encryptValue(key: CryptoKey, identity: Identity, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Bind identity inside the authenticated ciphertext; swapping rows cannot relabel a value.
  const payload = JSON.stringify({ format: FORMAT, ...identity, value });
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(payload));
  return { encryptedValue: toBase64(ciphertext), iv: toBase64(iv) };
}

export async function decryptValue(key: CryptoKey, secret: VaultSecret) {
  try {
    const clear = await subtle.decrypt({ name: "AES-GCM", iv: toBytes(secret.iv) }, key, toBytes(secret.encryptedValue));
    const data = JSON.parse(new TextDecoder().decode(clear));
    if (data.format !== FORMAT || data.key !== secret.key || data.environment !== secret.environment || data.provider !== secret.provider) {
      throw new Error("Identity mismatch");
    }
    return String(data.value);
  } catch {
    throw new Error(`Cannot decrypt ${secret.key}`);
  }
}

// Secrets written by the CLI use product "<project>/<resource>"; Sikrets groups on the project half.
export const projectOf = (secret: Pick<VaultSecret, "product">) => secret.product?.split("/")[0] || "unassigned";
