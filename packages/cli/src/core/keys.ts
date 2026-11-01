import path from "node:path";
import { managerFor } from "../managers/index.ts";
import { readJson, writeJson } from "./fs.ts";
import type { Secret } from "./secret.ts";
import { FILES, PROJECT_DIR } from "../constants.ts";

// Keys that came from outside Sikrets: imported from an export file or a password manager, or
// linked to a password manager item. .sikrets/keys.json holds names and item references only, so
// it can be committed; the values live in the project vault. A linked key gets each rotated value
// written back to its item, so the password manager stays the user's source of truth.

export interface ExternalKey {
  key: string;
  /** Where the value came from, e.g. "apple export", "bitwarden", ".env". */
  source: string;
  /** Password manager item this key mirrors (bw://… or op://…). */
  ref?: string;
  addedAt: string;
}

const file = (root: string) => path.join(root, PROJECT_DIR, FILES.keys);

export const externalKeys = async (root: string) => (await readJson<{ version: 1; keys: ExternalKey[] }>(file(root), { version: 1, keys: [] })).keys;

export async function saveExternalKeys(root: string, entries: readonly ExternalKey[]) {
  const incoming = new Map(entries.map((e) => [e.key, e]));
  const keys = (await externalKeys(root)).filter((k) => !incoming.has(k.key)).concat(entries);
  await writeJson(file(root), { version: 1, keys: keys.sort((a, b) => a.key.localeCompare(b.key)) });
}

export async function unlinkKey(root: string, key: string): Promise<boolean> {
  const keys = await externalKeys(root);
  const found = keys.find((k) => k.key === key && k.ref);
  if (!found) return false;
  await saveExternalKeys(root, [{ key: found.key, source: found.source, addedAt: found.addedAt }]);
  return true;
}

export interface WriteBack {
  key: string;
  ref: string;
  error?: string;
}

/** Writes new values to the password manager items their keys are linked to. Never throws: the rotation already happened. */
export async function writeBack(root: string, values: ReadonlyMap<string, Secret>, say: (m: string) => void): Promise<WriteBack[]> {
  const out: WriteBack[] = [];
  for (const { key, ref } of await externalKeys(root)) {
    const value = values.get(key);
    if (!ref || !value) continue;
    const m = managerFor(ref);
    try {
      await m.write(ref, value);
      say(`  Wrote the new ${key} back to ${m.name} (${ref})`);
      out.push({ key, ref });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      say(`  ! Couldn't write ${key} back to ${m.name}: ${message}. Update ${ref} by hand.`);
      out.push({ key, ref, error: message });
    }
  }
  return out;
}
