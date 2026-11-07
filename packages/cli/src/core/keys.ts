import path from "node:path";
import { managerFor } from "../managers/index.ts";
import { readJson, writeJson } from "./fs.ts";
import { withLock } from "./lock.ts";
import type { Secret } from "./secret.ts";
import { FILES, PROJECT_DIR } from "../constants.ts";

// Keys that came from outside Sikrets: imported from an export file or a password manager, or
// linked to a password manager item. .sikrets/keys.json holds names and item references only, so
// it can be committed; the values live in the project vault. A linked key gets each rotated value
// written back to its item, so the password manager stays the user's source of truth.
//
// A linked key's `sync` says whether its item holds the vault's value. Rotation marks it pending
// before writing back, and only a successful write marks it synced, so a crash or a failed write
// leaves it pending. While pending, the item still holds the old (revoked) value, so link and import
// refuse to copy from it; `sikrets link --push` retries the write.

export interface ExternalKey {
  key: string;
  /** Where the value came from, e.g. "apple export", "bitwarden", ".env". */
  source: string;
  /** Password manager item this key mirrors (bw://… or op://…). */
  ref?: string;
  addedAt: string;
  /** Linked keys only. Missing means synced (files written before this field existed). */
  sync?: SyncState;
}

/** `attempt` changes on every new pending value, so a slower, older write-back can't mark a newer one synced. */
export type SyncState = { state: "synced"; at: string } | { state: "pending"; since: string; attempt: string; error?: string };

export const isPending = (k: ExternalKey) => Boolean(k.ref) && k.sync?.state === "pending";

const file = (root: string) => path.join(root, PROJECT_DIR, FILES.keys);

export const externalKeys = async (root: string) => (await readJson<{ version: 1; keys: ExternalKey[] }>(file(root), { version: 1, keys: [] })).keys;

/** Read-modify-write of keys.json under a cross-process lock, written atomically. */
export function updateExternalKeys<T>(root: string, fn: (keys: ExternalKey[]) => Promise<{ next: ExternalKey[]; result: T }> | { next: ExternalKey[]; result: T }): Promise<T> {
  return withLock(file(root), async () => {
    const { next, result } = await fn(await externalKeys(root));
    await writeJson(file(root), { version: 1, keys: [...next].sort((a, b) => a.key.localeCompare(b.key)) });
    return result;
  });
}

/**
 * Throws if copying into `keys` or from `refs` would overwrite a rotated value with the old one a
 * password manager item still holds.
 */
export function assertNotPending(current: readonly ExternalKey[], keys: readonly string[], refs: readonly string[] = []) {
  const blocked = current.filter((k) => isPending(k) && (keys.includes(k.key) || refs.includes(k.ref!)));
  if (!blocked.length) return;
  const list = blocked.map((k) => `${k.key} (${k.ref})`).join(", ");
  throw new Error(`The rotated value of ${list} never reached the password manager, so the item still holds the old, revoked value. Write it back first: sikrets link --push`);
}

const merge = (current: readonly ExternalKey[], entries: readonly ExternalKey[]) => {
  const incoming = new Set(entries.map((e) => e.key));
  return current.filter((k) => !incoming.has(k.key)).concat(entries);
};

/** Adds or replaces entries. Refuses to replace a key whose write-back is pending. */
export async function saveExternalKeys(root: string, entries: readonly ExternalKey[]) {
  await updateExternalKeys(root, (current) => {
    assertNotPending(current, entries.map((e) => e.key), entries.flatMap((e) => (e.ref ? [e.ref] : [])));
    return { next: merge(current, entries), result: undefined };
  });
}

/**
 * Copies values in under the keys.json lock: checks nothing is pending, runs `put` (the vault
 * writes), then records the entries, so a rotation can't slip in between the check and the copy.
 */
export async function importExternalKeys(root: string, entries: readonly ExternalKey[], put: () => Promise<void>) {
  await updateExternalKeys(root, async (current) => {
    assertNotPending(current, entries.map((e) => e.key), entries.flatMap((e) => (e.ref ? [e.ref] : [])));
    await put();
    return { next: merge(current, entries), result: undefined };
  });
}

export async function unlinkKey(root: string, key: string, force = false): Promise<boolean> {
  return updateExternalKeys(root, (current) => {
    const found = current.find((k) => k.key === key && k.ref);
    if (!found) return { next: current, result: false };
    if (!force) assertNotPending(current, [key]);
    const { ref: _, sync: __, ...rest } = found;
    return { next: current.map((k) => (k === found ? rest : k)), result: true };
  });
}

/** Records intent before writing back: every linked key in `keys` is pending until its write succeeds. Returns the attempt id. */
export async function markPending(root: string, keys: readonly string[], since = new Date().toISOString()): Promise<string> {
  const attempt = crypto.randomUUID();
  await updateExternalKeys(root, (current) => ({
    next: current.map((k) => (k.ref && keys.includes(k.key) ? { ...k, sync: { state: "pending", since: k.sync?.state === "pending" ? k.sync.since : since, attempt } } : k)),
    result: undefined,
  }));
  return attempt;
}

/** Updates one key's sync state, only if it is still pending for `attempt`. */
async function settle(root: string, key: string, attempt: string, next: (prev: Extract<SyncState, { state: "pending" }>) => SyncState) {
  await updateExternalKeys(root, (current) => ({
    next: current.map((k) => (k.key === key && k.sync?.state === "pending" && k.sync.attempt === attempt ? { ...k, sync: next(k.sync) } : k)),
    result: undefined,
  }));
}

export interface WriteBack {
  key: string;
  ref: string;
  error?: string;
}

/**
 * Writes new values to the password manager items their keys are linked to, marking each pending
 * first and synced once written. Never throws: the rotation already happened.
 */
export async function writeBack(root: string, values: ReadonlyMap<string, Secret>, say: (m: string) => void): Promise<WriteBack[]> {
  const linked = (await externalKeys(root)).filter((k) => k.ref && values.has(k.key));
  if (!linked.length) return [];
  const attempt = await markPending(root, linked.map((k) => k.key));
  const out: WriteBack[] = [];
  for (const { key, ref } of linked) {
    const value = values.get(key)!;
    const m = managerFor(ref!);
    try {
      await m.write(ref!, value);
      await settle(root, key, attempt, () => ({ state: "synced", at: new Date().toISOString() }));
      say(`  Wrote the new ${key} back to ${m.name} (${ref})`);
      out.push({ key, ref: ref! });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await settle(root, key, attempt, (prev) => ({ ...prev, error: message }));
      say(`  ! Couldn't write ${key} back to ${m.name}: ${message}. Retry with: sikrets link --push`);
      out.push({ key, ref: ref!, error: message });
    }
  }
  return out;
}

/** Retries every pending write-back with the vault's current value. */
export async function pushPending(root: string, read: (key: string) => Promise<Secret | undefined>, say: (m: string) => void): Promise<WriteBack[]> {
  const values = new Map<string, Secret>();
  for (const k of (await externalKeys(root)).filter(isPending)) {
    const value = await read(k.key);
    if (!value) throw new Error(`${k.key} is missing from the vault, so there is nothing to write back to ${k.ref}`);
    values.set(k.key, value);
  }
  return writeBack(root, values, say);
}
