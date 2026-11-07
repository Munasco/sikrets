import { envelopeKind, openValue, sealValue } from "./envelope.ts";
import type { SsmParams } from "./vault.ts";

// `sikrets migrate encrypt`: seals a project's legacy plaintext parameters in place. Idempotent:
// sealed values are checked (they must open under this device's key) and left alone, so it is safe
// to re-run after a partial failure, including one in the middle of --purge-history. Results carry
// key names only, never values.

export interface MigrateResult {
  /** Plaintext values sealed now (or that would be, in a dry run). */
  sealed: string[];
  /** Already sealed under this device's key. */
  already: string[];
  /** Sealed, but not under this key (another data key, a newer format, or tampered). Left untouched. */
  unreadable: string[];
  /** Recreated to drop their version history (--purge-history). */
  purged: string[];
  /** Written by someone else while this ran. Left as they are; re-run to pick them up. */
  changed: string[];
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
  const result: MigrateResult = { sealed: [], already: [], unreadable: [], purged: [], changed: [] };
  if (!opts.dryRun) await resume(params);
  for (const [name, stored] of [...(await params.list())].sort(([a], [b]) => a.localeCompare(b))) {
    let next = stored;
    if (envelopeKind(stored) !== "plain") {
      try {
        openValue(key, params.path(name), stored);
      } catch {
        result.unreadable.push(name);
        continue;
      }
      result.already.push(name);
      if (!opts.purgeHistory || opts.dryRun) continue;
    } else {
      if (opts.dryRun) {
        result.sealed.push(name);
        continue;
      }
      next = sealValue(key, params.path(name), stored);
    }
    const done = opts.purgeHistory ? await recreate(params, name, stored, next) : await replace(params, name, stored, next);
    if (!done) result.changed.push(name);
    else {
      if (next !== stored) result.sealed.push(name);
      if (opts.purgeHistory) result.purged.push(name);
    }
  }
  if (result.changed.length) result.already = result.already.filter((n) => !result.changed.includes(n));
  return result;
}

/**
 * In-place overwrite, unless the value changed since it was listed (a rotation mid-run). SSM has no
 * compare-and-set on PutParameter, so this re-reads right before writing; the window left is small.
 */
async function replace(params: SsmParams, name: string, expected: string, next: string): Promise<boolean> {
  if ((await params.get(name)) !== expected) return false;
  await params.put(name, next);
  return true;
}

/**
 * Deletes and recreates `name` holding `next`, which drops its version history. The value is staged
 * under a sibling name first, so a failure at any step loses nothing and the next run finishes it.
 */
async function recreate(params: SsmParams, name: string, expected: string, next: string): Promise<boolean> {
  if ((await params.get(name)) !== expected) return false;
  await params.stage(name, next);
  await params.delete(name);
  // Overwrite: false, so a value written in between is kept rather than replaced.
  const created = await params.create(name, next);
  await params.unstage(name);
  return created;
}

/** Finishes recreations a previous run started: put back any staged value whose parameter is gone. */
async function resume(params: SsmParams) {
  for (const [name, staged] of await params.staged()) {
    await params.create(name, staged); // a no-op when the parameter is still (or already again) there
    await params.unstage(name);
  }
}
