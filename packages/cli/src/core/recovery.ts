import crypto, { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { configDir } from "../store.ts";
import { fingerprint, open, seal, type Sealed } from "./datakey.ts";
import { privateDir, readJson } from "./fs.ts";
import { createExclusive, withLock, writeAtomic } from "./lock.ts";
import { combine, split, type Share } from "./shamir.ts";
import { RECOVERY } from "../constants.ts";

// Account recovery without us ever holding a key. A recovery code is 160 random bits shown once;
// Argon2id stretches it into a wrapping key, and only the data key wrapped under that (AES-GCM) is
// stored. Lose the device and the code plus the wrapped record rebuild access; lose the code and
// nobody, including us, can. Optionally the code is split 2-of-3 for emergency contacts.

export interface KdfParams {
  name: "argon2id" | "scrypt";
  salt: string;
  [param: string]: string | number;
}

export type RecoveryState = "unused" | "used";

export interface RecoveryRecord {
  version: 1;
  /** Changes on every setup/rotate; bound into the wrap so an old record can't be swapped in. */
  id: string;
  createdAt: string;
  /** Which data key this unlocks, without revealing it. */
  fingerprint: string;
  /** The code was split into shares rather than shown whole. */
  split: boolean;
  /**
   * "used" once a restore has accepted the code: it was typed on some device, so it should be
   * replaced (sikrets recovery rotate). Older records have no state and count as unused.
   */
  state?: RecoveryState;
  usedAt?: string;
  kdf: KdfParams;
  wrapped: Sealed;
}

export class WrongCodeError extends Error {
  constructor() {
    super("That recovery code doesn't unlock this vault. Nothing changed.");
  }
}

// ── Codes: Crockford base32 in groups, with a checksum group to catch typos ──

const A = RECOVERY.alphabet;

function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) out += A[(acc >>> (bits -= 5)) & 31];
  }
  return bits ? out + A[(acc << (5 - bits)) & 31] : out;
}

function unbase32(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let bits = 0;
  let acc = 0;
  let i = 0;
  for (const ch of text) {
    acc = ((acc << 5) | A.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8 && i < length) out[i++] = (acc >>> (bits -= 8)) & 0xff;
  }
  return out;
}

const checksum = (bytes: Uint8Array) => base32(createHash("sha256").update(bytes).digest().subarray(0, 3)).slice(0, RECOVERY.checksumChars);
const group = (text: string) => text.match(new RegExp(`.{1,${RECOVERY.groupSize}}`, "g"))!.join("-");

export const encodeCode = (bytes: Uint8Array) => group(base32(bytes) + checksum(bytes));

/** Accepts any case, spaces or dashes, and the usual look-alikes (O→0, I/L→1). */
export function decodeCode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const dataChars = Math.ceil((RECOVERY.codeBytes * 8) / 5);
  if (clean.length !== dataChars + RECOVERY.checksumChars || [...clean].some((c) => !A.includes(c))) {
    throw new Error(`A recovery code is ${(dataChars + RECOVERY.checksumChars) / RECOVERY.groupSize} groups of ${RECOVERY.groupSize} characters`);
  }
  const bytes = unbase32(clean.slice(0, dataChars), RECOVERY.codeBytes);
  if (checksum(bytes) !== clean.slice(dataChars)) throw new Error("That code has a typo (its checksum doesn't match). Check each group and try again.");
  return bytes;
}

export const encodeShare = (s: Share) => `${RECOVERY.sharePrefix}${s.x}-${encodeCode(s.y)}`;

const SHARE = new RegExp(`^\\s*${RECOVERY.sharePrefix}(\\d)-`, "i");
export const isShare = (text: string) => SHARE.test(text);

export function decodeShare(text: string): Share {
  const m = SHARE.exec(text);
  if (!m) throw new Error("That isn't a recovery share");
  return { x: Number(m[1]), y: decodeCode(text.slice(m[0].length)) };
}

/** Rebuilds the code's secret from either the whole code or enough shares. */
export function secretFrom(inputs: readonly string[]): Uint8Array {
  if (inputs.length === 1 && !isShare(inputs[0]!)) return decodeCode(inputs[0]!);
  if (inputs.length < RECOVERY.threshold || !inputs.every(isShare)) throw new Error(`Give ${RECOVERY.threshold} different recovery shares`);
  return combine(inputs.map(decodeShare));
}

/** A new secret plus what to show the person: one code, or one share per holder. */
export function newCode(opts: { split?: boolean } = {}): { secret: Uint8Array; shown: string[] } {
  const secret = randomBytes(RECOVERY.codeBytes);
  const shown = opts.split ? split(secret, RECOVERY.shares, RECOVERY.threshold).map(encodeShare) : [encodeCode(secret)];
  return { secret, shown };
}

// ── KDF and wrapping ──

type Argon2 = (algorithm: string, params: Record<string, unknown>) => Promise<Buffer>;
const argon2 = (crypto as unknown as { argon2?: Function }).argon2 ? (promisify((crypto as unknown as { argon2: Function }).argon2) as Argon2) : undefined;
const scrypt = promisify(crypto.scrypt) as (pw: Uint8Array, salt: Uint8Array, len: number, opts: object) => Promise<Buffer>;

function newKdf(): KdfParams {
  const salt = randomBytes(RECOVERY.saltBytes).toString("base64");
  return argon2 ? { name: "argon2id", salt, ...RECOVERY.argon2 } : { name: "scrypt", salt, ...RECOVERY.scrypt };
}

export async function deriveKey(secret: Uint8Array, kdf: KdfParams): Promise<Buffer> {
  const salt = Buffer.from(kdf.salt, "base64");
  if (kdf.name === "argon2id") {
    if (!argon2) throw new Error("This runtime has no Argon2id; update Bun to restore this record");
    return argon2("argon2id", { message: secret, nonce: salt, tagLength: 32, memory: kdf.memoryKiB, passes: kdf.passes, parallelism: kdf.parallelism });
  }
  return scrypt(secret, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: kdf.maxmem });
}

const aad = (r: Pick<RecoveryRecord, "id" | "fingerprint">) => `${RECOVERY.aad}|${r.id}|${r.fingerprint}`;

export async function wrap(dataKey: Uint8Array, secret: Uint8Array, opts: { split?: boolean } = {}): Promise<RecoveryRecord> {
  const head = { version: 1 as const, id: `rk_${randomBytes(6).toString("hex")}`, createdAt: new Date().toISOString(), fingerprint: fingerprint(dataKey), split: opts.split ?? false, state: "unused" as const };
  const kdf = newKdf();
  return { ...head, kdf, wrapped: seal(await deriveKey(secret, kdf), dataKey, aad(head)) };
}

export async function unwrap(record: RecoveryRecord, secret: Uint8Array): Promise<Buffer> {
  let key: Buffer;
  try {
    key = open(await deriveKey(secret, record.kdf), record.wrapped, aad(record));
  } catch {
    throw new WrongCodeError();
  }
  if (fingerprint(key) !== record.fingerprint) throw new WrongCodeError();
  return key;
}

// ── Where the record lives ──

export const recoveryFile = () => path.join(configDir(), RECOVERY.file);

export async function readRecord(file = recoveryFile()): Promise<RecoveryRecord | undefined> {
  const r = await readJson<RecoveryRecord | undefined>(file, undefined);
  if (r && (r.version !== 1 || !r.wrapped || !r.kdf)) throw new Error(`${file} isn't a Sikrets recovery record`);
  return r;
}

export const recordState = (r: RecoveryRecord): RecoveryState => r.state ?? "unused";

const text = (record: RecoveryRecord) => JSON.stringify(record, null, 2) + "\n";

/** Replacing the record is what invalidates the previous code: nothing it can unwrap remains. */
export async function writeRecord(record: RecoveryRecord, file = recoveryFile()) {
  await privateDir(path.dirname(file));
  await writeAtomic(file, text(record), 0o600);
}

/** First setup: writes the record only if none exists, so two setups can't overwrite each other. */
export async function createRecord(record: RecoveryRecord, file = recoveryFile()) {
  await privateDir(path.dirname(file));
  if (!(await createExclusive(file, text(record), 0o600))) throw new Error("Recovery was set up meanwhile, by another run. Nothing changed; to replace that code, run: sikrets recovery rotate");
}

/** Rotate: replaces the record only if it is still the one this run read. */
export async function replaceRecord(record: RecoveryRecord, previousId: string, file = recoveryFile()) {
  await withLock(file, async () => {
    const now = await readRecord(file);
    if (now?.id !== previousId) throw new Error("The recovery record changed while this ran. Nothing changed; check with: sikrets recovery status");
    await writeRecord(record, file);
  });
}

/** After a restore accepted the code: record that it has been used, so status asks for a new one. */
export async function markUsed(id: string, file = recoveryFile(), now = new Date()) {
  await withLock(file, async () => {
    const r = await readRecord(file);
    if (r?.id === id && recordState(r) === "unused") await writeRecord({ ...r, state: "used", usedAt: now.toISOString() }, file);
  });
}
