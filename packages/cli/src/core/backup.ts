import { hkdfSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "./config.ts";
import { fingerprint, open, seal, type Sealed } from "./datakey.ts";
import { deriveKey, newKdf, type KdfParams } from "./recovery.ts";
import { remove } from "./fs.ts";
import type { Resource } from "./state.ts";
import type { Connection } from "../store.ts";
import { BACKUP } from "../constants.ts";

// Encrypted, portable backups of one project: every vault value (real values and stand-ins), its
// state and sikrets.json, plus your provider links and logins. The whole payload is one AES-256-GCM
// box. It opens with the data key (default; restore that first with a recovery code) or with a
// passphrase through Argon2id, so it also opens on a machine that has neither. The readable header
// is bound in as associated data, so editing it breaks the box.

export interface Login {
  provider: string;
  /** Keychain account name: the login email, or "<email>#<key>" for a minted API key. */
  account: string;
  value: string;
}

export interface BackupPayload {
  project: string;
  /** Vault key → value, as the vault returns it (decrypted). */
  values: Record<string, string>;
  resources: Resource[];
  config?: ProjectConfig;
  connections: Connection[];
  logins: Login[];
}

export interface BackupHeader {
  format: typeof BACKUP.format;
  version: typeof BACKUP.version;
  createdAt: string;
  project: string;
  mode: "datakey" | "passphrase";
  /** datakey: which data key opens it, without revealing it. */
  fingerprint?: string;
  /** passphrase: how to stretch it. */
  kdf?: KdfParams;
}

export interface BackupFile extends BackupHeader {
  sealed: Sealed;
}

export type Unlock = { dataKey: Uint8Array } | { passphrase: string };

export class BackupError extends Error {}

/** Fixed field order, so the same header always gives the same associated data. */
const aad = (h: BackupHeader) =>
  `${BACKUP.aad}|${JSON.stringify([h.format, h.version, h.createdAt, h.project, h.mode, h.fingerprint ?? null, h.kdf ?? null])}`;

const backupKey = (dataKey: Uint8Array) => Buffer.from(hkdfSync("sha256", dataKey, "", BACKUP.hkdfInfo, 32));
const passphraseBytes = (p: string) => Buffer.from(p.normalize("NFC"), "utf8");

export async function sealBackup(payload: BackupPayload, unlock: Unlock, now = new Date()): Promise<BackupFile> {
  const base = { format: BACKUP.format, version: BACKUP.version, createdAt: now.toISOString(), project: payload.project } as const;
  let header: BackupHeader;
  let key: Buffer;
  if ("dataKey" in unlock) {
    header = { ...base, mode: "datakey", fingerprint: fingerprint(unlock.dataKey) };
    key = backupKey(unlock.dataKey);
  } else {
    if (unlock.passphrase.length < BACKUP.minPassphrase) throw new BackupError(`Use a passphrase of at least ${BACKUP.minPassphrase} characters`);
    header = { ...base, mode: "passphrase", kdf: newKdf() };
    key = await deriveKey(passphraseBytes(unlock.passphrase), header.kdf!);
  }
  return { ...header, sealed: seal(key, Buffer.from(JSON.stringify(payload)), aad(header)) };
}

/** Checks the shape only; nothing is decrypted. Throws BackupError for anything that isn't a backup. */
export function parseBackup(text: string): BackupFile {
  let raw: Partial<BackupFile>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError("That file isn't a Sikrets backup (it isn't valid JSON)");
  }
  if (raw?.format !== BACKUP.format) throw new BackupError("That file isn't a Sikrets backup");
  if (raw.version !== BACKUP.version) throw new BackupError(`Backup version ${raw.version} isn't supported by this Sikrets; update the CLI`);
  const sealedOk = raw.sealed && ["iv", "ct", "tag"].every((k) => typeof (raw.sealed as unknown as Record<string, unknown>)[k] === "string");
  const modeOk = (raw.mode === "datakey" && typeof raw.fingerprint === "string") || (raw.mode === "passphrase" && typeof raw.kdf?.salt === "string");
  if (!sealedOk || !modeOk || typeof raw.createdAt !== "string" || typeof raw.project !== "string") throw new BackupError("The backup is corrupt (its header is incomplete)");
  return raw as BackupFile;
}

export async function openBackup(file: BackupFile, unlock: Unlock): Promise<BackupPayload> {
  let key: Buffer;
  if (file.mode === "datakey") {
    if (!("dataKey" in unlock)) throw new BackupError("This backup is sealed with a data key, not a passphrase");
    if (fingerprint(unlock.dataKey) !== file.fingerprint) throw new BackupError("This backup was made with a different data key. Restore that key first: sikrets recovery restore");
    key = backupKey(unlock.dataKey);
  } else {
    if (!("passphrase" in unlock)) throw new BackupError("This backup is sealed with a passphrase; pass --passphrase");
    key = await deriveKey(passphraseBytes(unlock.passphrase), file.kdf!);
  }
  let plain: Buffer;
  try {
    plain = open(key, file.sealed, aad(file));
  } catch {
    // GCM can't tell a wrong passphrase from an edited file, and neither should we guess.
    throw new BackupError(file.mode === "passphrase" ? "Wrong passphrase, or the backup was changed or corrupted" : "The backup was changed or corrupted");
  }
  const payload = JSON.parse(plain.toString("utf8")) as BackupPayload;
  if (payload.project !== file.project || typeof payload.values !== "object") throw new BackupError("The backup is corrupt (its contents don't match its header)");
  return payload;
}

/** Counts and names only, for verify and dry runs. Never values. */
export function summarize(p: BackupPayload) {
  return {
    project: p.project,
    values: Object.keys(p.values).length,
    keys: Object.keys(p.values).sort(),
    resources: p.resources.map((r) => r.name),
    connections: p.connections.map((c) => `${c.provider}:${c.account}`),
    logins: p.logins.length,
    config: Boolean(p.config),
  };
}

export interface RestorePlan {
  add: string[];
  replace: string[];
  same: string[];
}

/** What restoring the values would do to a vault that currently holds `current`. */
export function planRestore(payload: BackupPayload, current: ReadonlyMap<string, string | undefined>): RestorePlan {
  const plan: RestorePlan = { add: [], replace: [], same: [] };
  for (const [key, value] of Object.entries(payload.values).sort(([a], [b]) => a.localeCompare(b))) {
    const now = current.get(key);
    (now === undefined ? plan.add : now === value ? plan.same : plan.replace).push(key);
  }
  return plan;
}

/** --dir: keeps the newest `keep` backups of this project in `dir` and deletes the rest. */
export async function prune(dir: string, project: string, keep: number): Promise<string[]> {
  const own = BACKUP.filePattern(project);
  const mine = (await readdir(dir).catch(() => [] as string[])).filter((f) => own.test(f)).sort();
  const old = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of old) await remove(path.join(dir, f));
  return old;
}
