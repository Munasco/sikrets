import { envelopeKind, openValue, sealValue } from "./envelope.ts";
import type { SsmParams } from "./vault.ts";

// `sikrets migrate encrypt`: seals a project's legacy plaintext parameters in place. Idempotent:
// sealed values are checked (they must open under this device's key) and left alone, so it is safe
// to re-run after a partial failure. Results carry key names only, never values.

export interface MigrateResult {
  /** Plaintext values sealed now (or that would be, in a dry run). */
  sealed: string[];
  /** Already sealed under this device's key. */
  already: string[];
  /** Sealed, but not under this key (another data key, a newer format, or tampered). Left untouched. */
  unreadable: string[];
  /** Recreated to drop their version history (--purge-history). */
  purged: string[];
}

export interface MigrateOptions {
  dryRun?: boolean;
  /**
   * SSM keeps up to 100 old versions of a parameter, so the plaintext stays in its history after an
   * in-place overwrite. Purging deletes the parameter and writes the sealed value as a fresh one,
   * including values sealed by an earlier run, whose history may still hold plaintext.
   */
  purgeHistory?: boolean;
}

export async function migrateEncrypt(params: SsmParams, key: Uint8Array, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const result: MigrateResult = { sealed: [], already: [], unreadable: [], purged: [] };
  for (const [name, stored] of [...(await params.list())].sort(([a], [b]) => a.localeCompare(b))) {
    if (envelopeKind(stored) !== "plain") {
      try {
        openValue(key, params.path(name), stored);
        result.already.push(name);
        if (opts.purgeHistory && !opts.dryRun) {
          await params.delete(name);
          await params.put(name, stored);
          result.purged.push(name);
        }
      } catch {
        result.unreadable.push(name);
      }
      continue;
    }
    result.sealed.push(name);
    if (opts.dryRun) continue;
    const sealed = sealValue(key, params.path(name), stored);
    if (opts.purgeHistory) {
      await params.delete(name);
      result.purged.push(name);
    }
    await params.put(name, sealed);
  }
  return result;
}
