import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveExternalKeys, writeBack } from "../core/keys.ts";
import { Secret } from "../core/secret.ts";
import { bitwarden } from "./bitwarden.ts";
import { runCli } from "./exec.ts";
import { PASSWORD_MANAGERS } from "../constants.ts";

// End to end against a real Vaultwarden and the real `bw` CLI. Opt in with a running server. bw
// only accepts HTTPS, so give Vaultwarden a self-signed cert and point Node at it:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=localhost \
//     -addext subjectAltName=DNS:localhost
//   docker create --name vw -e I_REALLY_WANT_VOLATILE_STORAGE=true \
//     -e ROCKET_TLS='{certs="/ssl/cert.pem",key="/ssl/key.pem"}' -p 8222:80 vaultwarden/server
//   docker cp cert.pem vw:/ssl/cert.pem && docker cp key.pem vw:/ssl/key.pem && docker start vw
//   NODE_EXTRA_CA_CERTS=$PWD/cert.pem SIKRETS_E2E_VAULTWARDEN=https://localhost:8222 \
//     SIKRETS_BW="bunx @bitwarden/cli" bun test vaultwarden
// It registers a throwaway account with fake values; bw's own state goes to a temp dir.

const SERVER = Bun.env.SIKRETS_E2E_VAULTWARDEN;
const BW = PASSWORD_MANAGERS.bitwarden;
const EMAIL = `e2e-${Date.now()}@example.com`;
const PASSWORD = "fake-e2e-master-password";
const ITERATIONS = 600_000;

// ── Account registration: the key derivation a Bitwarden client does before calling the API ──
type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
const pbkdf2 = async (secret: Bytes, salt: Bytes, iterations: number) =>
  new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]), 256));
const hmac = async (key: Bytes, data: Bytes) =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
/** Type 2 EncString: AES-256-CBC then HMAC-SHA256 over iv + ciphertext. */
async function encString(plain: Bytes, encKey: Bytes, macKey: Bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, await crypto.subtle.importKey("raw", encKey, "AES-CBC", false, ["encrypt"]), plain));
  return `2.${b64(iv)}|${b64(ct)}|${b64(await hmac(macKey, new Uint8Array([...iv, ...ct])))}`;
}
async function register(server: string) {
  const masterKey = await pbkdf2(enc.encode(PASSWORD), enc.encode(EMAIL.toLowerCase()), ITERATIONS);
  const hash = b64(await pbkdf2(masterKey, enc.encode(PASSWORD), 1));
  const stretchedEnc = await hmac(masterKey, new Uint8Array([...enc.encode("enc"), 1]));
  const stretchedMac = await hmac(masterKey, new Uint8Array([...enc.encode("mac"), 1]));
  const userKey = crypto.getRandomValues(new Uint8Array(64));
  const rsa = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
  // Without mail configured, Vaultwarden returns the email verification token directly.
  const post = async (route: string, body: unknown) => {
    const res = await fetch(`${server}/identity/accounts/register/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      tls: { rejectUnauthorized: false }, // the throwaway server's self-signed cert
    });
    if (!res.ok) throw new Error(`register/${route} failed: HTTP ${res.status}`);
    return res.text();
  };
  const token = await post("send-verification-email", { email: EMAIL, name: "e2e", receiveMarketingEmails: false });
  await post("finish", {
    email: EMAIL,
    emailVerificationToken: token,
    masterPasswordHash: hash,
    masterPasswordHint: null,
    userSymmetricKey: await encString(userKey, stretchedEnc, stretchedMac),
    userAsymmetricKeys: {
      publicKey: b64(await crypto.subtle.exportKey("spki", rsa.publicKey)),
      encryptedPrivateKey: await encString(new Uint8Array(await crypto.subtle.exportKey("pkcs8", rsa.privateKey)), userKey.slice(0, 32), userKey.slice(32)),
    },
    kdf: 0,
    kdfIterations: ITERATIONS,
  });
}

describe.skipIf(!SERVER)("Vaultwarden end to end", () => {
  const keychain = new Map<string, string>();
  let dir: string;
  let itemId: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-vw-"));
    process.env.SIKRETS_CONFIG_DIR = path.join(dir, "config");
    process.env[BW.appDataEnv] = path.join(dir, "bw");
    spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
    spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
    spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
    await register(SERVER!);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const session = () => ({ [BW.sessionEnv]: [...keychain.values()][0]! });

  test("unlock logs in to the self-hosted server and keeps the session in the keychain", async () => {
    expect(await bitwarden.unlock({ server: SERVER, email: EMAIL, password: async () => Secret.of(PASSWORD), say: () => {} })).toBe(EMAIL);
    expect(keychain.get(`dev.sikrets.bitwarden/${EMAIL}#session`)).toBeTruthy();
    const status = JSON.parse(await runCli(BW, ["status"], { env: session() }));
    expect(status).toMatchObject({ serverUrl: SERVER, userEmail: EMAIL, status: "unlocked" });
  }, 120_000);

  test("read, write back and list a real item", async () => {
    const item = { type: 1, name: "E2E GitHub", notes: null, login: { username: "dev", password: "fake-e2e-old" }, fields: [{ name: "deploy key", value: "fake-e2e-field", type: 1 }] };
    itemId = (JSON.parse(await runCli(BW, ["create", "item"], { env: session(), stdin: Buffer.from(JSON.stringify(item)).toString("base64") })) as { id: string }).id;

    expect((await bitwarden.read(`bw://${itemId}/password`)).reveal()).toBe("fake-e2e-old");
    expect((await bitwarden.read(`bw://${itemId}/deploy key`)).reveal()).toBe("fake-e2e-field");

    const root = path.join(dir, "project");
    await saveExternalKeys(root, [{ key: "GITHUB_TOKEN", source: "bitwarden", ref: `bw://${itemId}/password`, addedAt: new Date().toISOString() }]);
    const [result] = await writeBack(root, new Map([["GITHUB_TOKEN", Secret.of("fake-e2e-rotated")]]), () => {});
    expect(result?.error).toBeUndefined();

    // Fresh from the server, not the local cache.
    await runCli(BW, ["sync", "--force"], { env: session() });
    const stored = JSON.parse(await runCli(BW, ["get", "item", itemId], { env: session() }));
    expect(stored.login.password).toBe("fake-e2e-rotated");
    expect(stored.fields).toContainEqual(expect.objectContaining({ name: "deploy key", value: "fake-e2e-field" }));

    const listed = await bitwarden.list();
    expect(listed.map((e) => e.ref)).toEqual([`bw://${itemId}/password`, `bw://${itemId}/deploy key`]);
  }, 180_000);

  test("lock forgets the session and reads fail", async () => {
    await bitwarden.lock();
    expect(keychain.size).toBe(0);
    await expect(bitwarden.read(`bw://${itemId}/password`)).rejects.toThrow("locked");
  }, 60_000);
});
