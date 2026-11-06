import { createECDH, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign as signWith, verify, type KeyObject } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { configDir } from "../store.ts";
import { open, seal, type Sealed } from "./datakey.ts";
import { privateDir, readJson, readText, remove, writePrivate } from "./fs.ts";
import { swiftHelper } from "./swift.ts";
import deviceSource from "../native/device.swift" with { type: "text" };
import { DEVICE, ENV } from "../constants.ts";

// This device's identity: a signing key that proves "this request comes from this Mac" and a
// key-agreement key the vault data key is wrapped to. On a Mac with a Secure Enclave both are
// created there with no user-presence requirement, so using them never prompts; their private
// halves can't be exported, and the stored blobs (dataRepresentation) only work in this Mac's
// Enclave. Copying ~/.sikrets, a backup or a keychain dump to another machine yields nothing usable.
//
// The blobs live in 0600 files rather than the keychain: keychain items for Secure Enclave keys
// need a signed app with a keychain access group, and the CLI's helper is compiled locally and
// only signed ad hoc. The Enclave protects the key either way; the file only names it.
//
// Where there's no Enclave (Linux, CI, older Intel Macs) the same two keys are software P-256
// keys in 0600 files, and every place that shows the device says it is not hardware-bound.

export type KeyRole = "signing" | "agreement";
export type DeviceKind = "secure-enclave" | "software";

/** What wrapping the data key stores, besides the AES-GCM output. */
export interface UnwrapInput extends Sealed {
  /** The ephemeral public key (X9.63), base64. */
  epk: string;
  salt: string;
  info: string;
  aad: string;
}

/** One way of holding device keys. Files are paths to the key blobs; public keys are X9.63 points. */
export interface KeyBackend {
  readonly kind: DeviceKind;
  readonly hardwareBound: boolean;
  available(): Promise<boolean>;
  create(role: KeyRole, file: string): Promise<Buffer>;
  sign(file: string, data: Uint8Array): Promise<Buffer>;
  unwrap(file: string, input: UnwrapInput): Promise<Buffer>;
}

export class DeviceKeyError extends Error {}
/** The Secure Enclave helper can't run here at all (as opposed to refusing one operation). */
export class HelperMissingError extends DeviceKeyError {}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** X9.63 uncompressed point ⇄ JWK, the two forms the helper and node:crypto speak. */
export const pointToJwk = (point: Uint8Array): JsonWebKey => ({ kty: "EC", crv: "P-256", x: Buffer.from(point.subarray(1, 33)).toString("base64url"), y: Buffer.from(point.subarray(33, 65)).toString("base64url") });
const keyToPoint = (key: KeyObject) => {
  const { x, y } = key.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(x!, "base64url"), Buffer.from(y!, "base64url")]);
};

/** Identifies a public key without being it (hex of its SHA-256, shortened). */
export const thumbprint = (point: Uint8Array) => createHash("sha256").update(point).digest("hex").slice(0, DEVICE.thumbprintChars);

// ── Backends ──

/** Runs the Secure Enclave helper. Every call is silent: these keys have no user-presence rule. */
async function helper(args: string[], stdin?: Uint8Array): Promise<string> {
  const bin = await swiftHelper(deviceSource, DEVICE.helperName, { link: true });
  if (!bin) throw new HelperMissingError("The Secure Enclave helper couldn't be built (it needs swiftc: xcode-select --install)");
  const proc = Bun.spawn([bin, ...args], { stdin: stdin ? Buffer.from(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited];
  if (code !== 0) throw new DeviceKeyError(`Secure Enclave: ${err.trim() || `helper exited with ${code}`}`);
  return out.trim();
}

/** Tests replace these methods with fakes; nothing else talks to the Secure Enclave. */
export const enclave: KeyBackend = {
  kind: "secure-enclave",
  hardwareBound: true,
  async available() {
    if (process.platform !== "darwin") return false;
    return helper(["available"]).then(
      () => true,
      () => false,
    );
  },
  create: async (role, file) => Buffer.from(await helper(["create", role, file]), "base64"),
  sign: async (file, data) => Buffer.from(await helper(["sign", file], data), "base64"),
  unwrap: async (file, input) => Buffer.from(await helper(["unwrap", file], Buffer.from(JSON.stringify(input))), "base64"),
};

const softwareKey = async (file: string) => {
  const pem = await readText(file);
  if (!pem) throw new DeviceKeyError(`This device's key is missing (${file})`);
  return createPrivateKey(pem);
};

/** Shared secret → wrapping key → AES-GCM open; the same steps device.swift runs in the Enclave. */
export function unwrapWith(privateKey: KeyObject, input: UnwrapInput): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: pointToJwk(Buffer.from(input.epk, "base64")), format: "jwk" }) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(input.salt, "base64"), Buffer.from(input.info, "base64"), 32));
  return open(key, input, Buffer.from(input.aad, "base64").toString());
}

/** P-256 keys in 0600 files. Anyone who copies the files has the keys: never call this hardware-bound. */
export const software: KeyBackend = {
  kind: "software",
  hardwareBound: false,
  available: async () => true,
  async create(_role, file) {
    if (await Bun.file(file).exists()) throw new DeviceKeyError(`A key already exists at ${file}`);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await writePrivate(file, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
    return keyToPoint(publicKey);
  },
  sign: async (file, data) => signWith("sha256", data, { key: await softwareKey(file), dsaEncoding: "ieee-p1363" }),
  unwrap: async (file, input) => unwrapWith(await softwareKey(file), input),
};

// ── This device ──

export interface DeviceMeta {
  version: 1;
  kind: DeviceKind;
  hardwareBound: boolean;
  createdAt: string;
  /** Public halves only, base64 X9.63. */
  signingPublicKey: string;
  agreementPublicKey: string;
}

export interface DataKeyWrap extends UnwrapInput {
  version: 1;
  /** Thumbprint of the agreement key this was wrapped to, so a copy from another device is spotted. */
  recipient: string;
  /** Which data key this is (datakey.fingerprint), bound into the AES-GCM associated data. */
  fingerprint: string;
}

export interface Device {
  readonly meta: DeviceMeta;
  readonly hardwareBound: boolean;
  readonly signingPublicKey: Buffer;
  readonly agreementPublicKey: Buffer;
  sign(data: Uint8Array): Promise<Buffer>;
  /** Whether this device's keys work here: false for key blobs copied from another Mac. */
  works(): Promise<boolean>;
  /** Wraps a key to this device. Needs only the public key, so it never touches the Enclave. */
  wrap(key: Uint8Array, fingerprint: string): DataKeyWrap;
  unwrap(wrapped: DataKeyWrap): Promise<Buffer>;
}

export const deviceDir = () => path.join(configDir(), DEVICE.dir);
const file = (name: string) => path.join(deviceDir(), name);

/** Plain text for status output. Software keys always say they aren't hardware-bound. */
export const describeKind = (meta: Pick<DeviceMeta, "kind" | "hardwareBound">) =>
  meta.kind === "secure-enclave" && meta.hardwareBound ? "Secure Enclave (hardware-bound)" : "software key (not hardware-bound)";

export const readDeviceMeta = () => readJson<DeviceMeta | undefined>(file(DEVICE.metaFile), undefined);

const backendFor = (kind: DeviceKind) => (kind === "secure-enclave" ? enclave : software);

function bind(meta: DeviceMeta): Device {
  const backend = backendFor(meta.kind);
  const signingPublicKey = Buffer.from(meta.signingPublicKey, "base64");
  const agreementPublicKey = Buffer.from(meta.agreementPublicKey, "base64");
  const recipient = thumbprint(agreementPublicKey);
  const info = (epk: Uint8Array) => Buffer.from(`${DEVICE.wrapInfo}|${b64(epk)}|${meta.agreementPublicKey}`);
  return {
    meta,
    hardwareBound: backend.hardwareBound && meta.hardwareBound,
    signingPublicKey,
    agreementPublicKey,
    sign: (data) => backend.sign(file(DEVICE.signingKey), data),
    async works() {
      const probe = randomBytes(32);
      const signature = await backend.sign(file(DEVICE.signingKey), probe).catch(() => undefined);
      return Boolean(signature && verify("sha256", probe, { key: createPublicKey({ key: pointToJwk(signingPublicKey), format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature));
    },
    wrap(key, fingerprint) {
      const ephemeral = createECDH("prime256v1");
      const epk = ephemeral.generateKeys();
      const salt = Buffer.from(DEVICE.wrapSalt);
      const aad = `${DEVICE.wrapAad}|${fingerprint}|${recipient}`;
      const wrapping = Buffer.from(hkdfSync("sha256", ephemeral.computeSecret(agreementPublicKey), salt, info(epk), 32));
      return { version: 1, recipient, fingerprint, epk: b64(epk), salt: b64(salt), info: b64(info(epk)), aad: b64(Buffer.from(aad)), ...seal(wrapping, key, aad) };
    },
    async unwrap(wrapped) {
      if (wrapped.recipient !== recipient) throw new DeviceMismatchError();
      // Recompute what was bound in rather than trusting the stored copies.
      const epk = Buffer.from(wrapped.epk, "base64");
      const input: UnwrapInput = { epk: wrapped.epk, iv: wrapped.iv, ct: wrapped.ct, tag: wrapped.tag, salt: b64(Buffer.from(DEVICE.wrapSalt)), info: b64(info(epk)), aad: b64(Buffer.from(`${DEVICE.wrapAad}|${wrapped.fingerprint}|${recipient}`)) };
      try {
        return await backend.unwrap(file(DEVICE.agreementKey), input);
      } catch (error) {
        // Anything but a missing helper means these keys can't open it here.
        throw error instanceof HelperMissingError ? error : new DeviceMismatchError();
      }
    },
  };
}

/** The data key on disk was wrapped for another device's key (copied over, or this device's keys were reset). */
export class DeviceMismatchError extends Error {
  constructor(message = "The data key on this device was wrapped for a different device key, so it can't be opened here") {
    super(`${message}. Restore it with your recovery code: sikrets recovery restore --force`);
  }
}

let current: { dir: string; device: Promise<Device> } | undefined;

/** Forgets the cached device, e.g. after a test swaps the config dir or the backend. */
export const resetDeviceCache = () => void (current = undefined);

/** Deletes this device's keys, wrapped data key and session; the next use creates new keys. */
export async function resetDevice() {
  await rm(deviceDir(), { recursive: true, force: true });
  resetDeviceCache();
}

async function load(): Promise<Device> {
  const existing = await readDeviceMeta();
  if (existing) return bind(existing);
  const forced = Bun.env[ENV.deviceKeys] === DEVICE.forceSoftware;
  const backend = !forced && (await enclave.available()) ? enclave : software;
  // No metadata means no identity yet; clear what a half-finished setup left behind, unless a
  // data key is wrapped to it (then the metadata was lost, and deleting the key would lose that too).
  if (await Bun.file(file(DEVICE.dataKeyFile)).exists()) throw new DeviceMismatchError(`${file(DEVICE.metaFile)} is missing, so the wrapped data key next to it can't be opened`);
  await privateDir(deviceDir());
  for (const name of [DEVICE.signingKey, DEVICE.agreementKey]) await remove(file(name));
  const signingPublicKey = await backend.create("signing", file(DEVICE.signingKey));
  const agreementPublicKey = await backend.create("agreement", file(DEVICE.agreementKey));
  const meta: DeviceMeta = { version: 1, kind: backend.kind, hardwareBound: backend.hardwareBound, createdAt: new Date().toISOString(), signingPublicKey: b64(signingPublicKey), agreementPublicKey: b64(agreementPublicKey) };
  await writePrivate(file(DEVICE.metaFile), JSON.stringify(meta, null, 2) + "\n");
  return bind(meta);
}

/**
 * This device, creating its keys on first use: in the Secure Enclave when there is one, otherwise
 * software keys. Once created, the kind never changes silently; if the Enclave helper stops
 * working, operations fail instead of falling back to keys that aren't hardware-bound.
 */
export async function thisDevice(): Promise<Device> {
  const dir = deviceDir();
  if (current?.dir !== dir) {
    const device = load();
    current = { dir, device };
    device.catch(() => current?.device === device && (current = undefined));
  }
  return current.device;
}
