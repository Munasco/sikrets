import path from "node:path";
import { awsClientConfig } from "../providers/aws.ts";
import { configDir } from "../store.ts";
import { ensureDataKey, fingerprint, loadDataKey } from "./datakey.ts";
import { EnvelopeError, envelopeKind, openValue, projectKey, sealValue } from "./envelope.ts";
import { withLock } from "./lock.ts";
import { registerUndo } from "./plan.ts";
import { readRecord } from "./recovery.ts";
import { Secret } from "./secret.ts";
import { DATA_KEY_MARKER, keychainVaultService, SSM_PREFIX, SSM_STANDARD_MAX_BYTES, vaultLockFile } from "../constants.ts";

// Where provisioned credentials live. Until the Sikrets platform vault ships, the default is AWS
// SSM Parameter Store (IAM-controlled, shared by everyone on the account); the OS keychain is the
// single-machine fallback. Values only ever cross this boundary wrapped in Secret. Every value is
// sealed on this machine before it is stored (see envelope.ts), so neither AWS nor anything else
// reading the backend holds a key that opens it. Reads never write: legacy plaintext is refused
// (anyone who can write the backend could have planted it) until `sikrets seal` seals it, on
// purpose, with a check that the value didn't change in between.

export type VaultName = "ssm" | "keychain";

export interface Vault {
  readonly name: VaultName;
  put(key: string, value: Secret): Promise<void>;
  get(key: string): Promise<Secret | undefined>;
  /** Whether a value is stored, without decrypting it. */
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** The one method of SSMClient Sikrets uses, so tests can pass a fake. */
export interface SsmClient {
  send(command: object): Promise<any>;
}

export interface VaultOptions {
  /** Defaults to an SSMClient for the connected AWS profile. */
  ssm?: SsmClient;
}

const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
export const isVaultKey = (key: string) => KEY.test(key);
const checkKey = (key: string) => {
  if (!KEY.test(key)) throw new Error(`Invalid vault key "${key}"`);
  return key;
};

const MISMATCH_HINT = "This device's data key isn't the one this project's values are sealed with. Restore that key with: sikrets recovery restore --force";
const RESTORE_HINT = "This device doesn't have your data key, so it can't open or add to this vault. Restore it with your recovery code: sikrets recovery restore";

/** A stored value and its version: equal versions mean nothing was written in between. */
export interface Stored {
  value: string;
  version: string;
}

/** Values exactly as a backend holds them: envelopes, or legacy plaintext. */
export interface RawStore {
  get(key: string): Promise<string | undefined>;
  getVersioned(key: string): Promise<Stored | undefined>;
  put(key: string, stored: string): Promise<void>;
  /** Writes `stored` only if `key` still holds `expected`. False (and nothing lost) if it changed. */
  replaceIf(key: string, expected: Stored, stored: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Every key stored for the project; only backends that can list implement it. */
  list?(): Promise<string[]>;
  /** Whether any of the project's values is sealed; only backends that can list implement it. */
  anySealed?(): Promise<boolean>;
  /** Shared backends record which data key the project is sealed under: created once, never overwritten. */
  marker?(): Promise<string | undefined>;
  /** Claims the marker for `fp` unless one exists; returns whichever fingerprint holds it. */
  claimMarker?(fp: string): Promise<string>;
  maxBytes?: number;
}

function keychainStore(project: string): RawStore {
  const service = keychainVaultService(project);
  // The keychain has no versions or conditional writes; a lock file stands in for both.
  const locked = <T>(fn: () => Promise<T>) => withLock(path.join(configDir(), vaultLockFile(project)), fn);
  const get = async (key: string) => (await Bun.secrets.get({ service, name: key })) || undefined;
  return {
    get,
    getVersioned: async (key) => {
      const value = await get(key);
      return value === undefined ? undefined : { value, version: value };
    },
    put: (key, stored) => locked(() => Bun.secrets.set({ service, name: key, value: stored })),
    replaceIf: (key, expected, stored) =>
      locked(async () => {
        if ((await get(key)) !== expected.value) return false;
        await Bun.secrets.set({ service, name: key, value: stored });
        return true;
      }),
    delete: (key) => locked(async () => void (await Bun.secrets.delete({ service, name: key }))),
  };
}

async function ssmStore(project: string, client?: SsmClient): Promise<RawStore> {
  const { SSMClient, PutParameterCommand, GetParameterCommand, GetParameterHistoryCommand, GetParametersByPathCommand, DeleteParameterCommand, ParameterNotFound } = await import("@aws-sdk/client-ssm");
  const c: SsmClient = client ?? new SSMClient(await awsClientConfig());
  const prefix = `${SSM_PREFIX}/${project}`;
  const path = (key: string) => `${prefix}/${key}`;
  const missing = (error: unknown) => error instanceof ParameterNotFound || (error as { name?: string })?.name === "ParameterNotFound";
  const getVersioned = async (key: string): Promise<Stored | undefined> => {
    try {
      const p = (await c.send(new GetParameterCommand({ Name: path(key), WithDecryption: true }))).Parameter;
      return p?.Value ? { value: p.Value, version: String(p.Version ?? "") } : undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  };
  const list = async (each: (p: { Name?: string; Value?: string }) => boolean | void) => {
    let NextToken: string | undefined;
    do {
      const page = await c.send(new GetParametersByPathCommand({ Path: prefix, Recursive: false, WithDecryption: true, NextToken }));
      for (const p of page.Parameters ?? []) if (each(p) === true) return true;
      NextToken = page.NextToken;
    } while (NextToken);
    return false;
  };
  return {
    maxBytes: SSM_STANDARD_MAX_BYTES,
    get: async (key) => (await getVersioned(key))?.value,
    getVersioned,
    // SSM has no conditional put. Check the version right before, then confirm ours is the very
    // next one; if another write slipped in between, put that newer value back and report it.
    async replaceIf(key, expected, stored) {
      if ((await getVersioned(key))?.version !== expected.version) return false;
      const put = await c.send(new PutParameterCommand({ Name: path(key), Value: stored, Type: "SecureString", Overwrite: true, Tier: "Standard" }));
      const before = Number(expected.version);
      if (!Number.isInteger(before) || put?.Version === undefined || put.Version === before + 1) return true;
      const history: { Version?: number; Value?: string }[] = [];
      let NextToken: string | undefined;
      do {
        const page = await c.send(new GetParameterHistoryCommand({ Name: path(key), WithDecryption: true, NextToken }));
        history.push(...(page.Parameters ?? []));
        NextToken = page.NextToken;
      } while (NextToken);
      const theirs = history.filter((h) => h.Version! > before && h.Version! < put.Version).sort((a, b) => b.Version! - a.Version!)[0];
      if (theirs?.Value) await c.send(new PutParameterCommand({ Name: path(key), Value: theirs.Value, Type: "SecureString", Overwrite: true, Tier: "Standard" }));
      return false;
    },
    // Still a SecureString: KMS stays on as a second layer, it just no longer holds the only key.
    put: async (key, stored) => void (await c.send(new PutParameterCommand({ Name: path(key), Value: stored, Type: "SecureString", Overwrite: true, Tier: "Standard" }))),
    async delete(key) {
      try {
        await c.send(new DeleteParameterCommand({ Name: path(key) }));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
    async list() {
      const names: string[] = [];
      await list((p) => void (p.Name && names.push(p.Name.slice(prefix.length + 1))));
      return names;
    },
    anySealed: () => list((p) => Boolean(p.Value && p.Name !== path(DATA_KEY_MARKER) && envelopeKind(p.Value) !== "plain")),
    marker: async () => (await getVersioned(DATA_KEY_MARKER))?.value,
    async claimMarker(fp) {
      try {
        // A plain String: a fingerprint reveals nothing, and anyone reading the project may check it.
        await c.send(new PutParameterCommand({ Name: path(DATA_KEY_MARKER), Value: fp, Type: "String", Overwrite: false, Tier: "Standard" }));
        return fp;
      } catch (error) {
        if ((error as { name?: string })?.name !== "ParameterAlreadyExists") throw error;
        return (await getVersioned(DATA_KEY_MARKER))?.value ?? fp;
      }
    },
  };
}

/** The vault, plus what `sikrets seal` needs: the raw store and the write-path project key. */
export interface SealableVault extends Vault {
  readonly store: RawStore;
  writeKey(key: string): Promise<Uint8Array>;
  seal(key: string, writeKey: Uint8Array, plaintext: string): string;
}

export const plaintextHint = (key: string) => `${key} is stored unencrypted, so it isn't trusted. Check it, then seal it with: sikrets seal --apply`;

function sealedVault(project: string, name: VaultName, store: RawStore): SealableVault {
  const readKey = async () => {
    const dataKey = await loadDataKey();
    if (!dataKey) throw new Error(RESTORE_HINT);
    return projectKey(dataKey, project);
  };

  // A device without a data key creates one only when nothing says one already exists (no
  // recovery record, no sealed values, no marker). Otherwise it would quietly seal new values under
  // a key no other device holds, next to old ones it can't open. On a shared backend the project's
  // marker is claimed with a create-only write, so of two fresh devices only the first one's key is
  // used; the other is refused before it writes anything.
  let claimed: string | undefined; // checked once per vault, not on every write
  const claim = async (dataKey: Uint8Array) => {
    const mine = fingerprint(dataKey);
    if (!store.claimMarker || claimed === mine) return;
    if ((await store.claimMarker(mine)) !== mine) throw new Error(MISMATCH_HINT);
    claimed = mine;
  };
  const writeKey = async (key: string) => {
    const existing = await loadDataKey();
    if (existing) {
      await claim(existing);
      return projectKey(existing, project);
    }
    const current = await store.get(key);
    if ((await readRecord()) || (await store.marker?.()) || (current && envelopeKind(current) !== "plain") || (await store.anySealed?.())) throw new Error(RESTORE_HINT);
    const created = await ensureDataKey();
    await claim(created);
    return projectKey(created, project);
  };

  const seal = (key: string, k: Uint8Array, plaintext: string) => {
    const stored = sealValue(k, project, key, plaintext);
    const size = Buffer.byteLength(stored);
    if (store.maxBytes && size > store.maxBytes) {
      throw new Error(`${key} is too large for the ${name} vault once encrypted (${size} of ${store.maxBytes} bytes). Values up to about 3 KB fit; use the keychain vault for larger ones`);
    }
    return stored;
  };

  return {
    name,
    store,
    writeKey,
    seal,
    put: async (key, value) => store.put(checkKey(key), seal(key, await writeKey(key), value.reveal())),
    // A read never writes and never creates a key.
    async get(key) {
      const stored = await store.get(checkKey(key));
      if (stored === undefined) return undefined;
      if (envelopeKind(stored) === "plain") throw new EnvelopeError(plaintextHint(key));
      return Secret.of(openValue(await readKey(), project, key, stored));
    },
    has: async (key) => (await store.get(checkKey(key))) !== undefined,
    delete: (key) => store.delete(checkKey(key)),
  };
}

export const openVault = async (project: string, name: VaultName, opts: VaultOptions = {}): Promise<SealableVault> =>
  sealedVault(project, name, name === "ssm" ? await ssmStore(project, opts.ssm) : keychainStore(project));

registerUndo("vault.delete", async ({ project, keys }, ctx) => {
  const vault = await openVault(project!, ctx.vault);
  for (const key of keys!.split(",")) await vault.delete(key);
});
