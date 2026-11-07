import { awsClientConfig } from "../providers/aws.ts";
import { ensureDataKey, fingerprint, loadDataKey } from "./datakey.ts";
import { envelopeKind, openValue, projectKey, sealValue } from "./envelope.ts";
import { registerUndo } from "./plan.ts";
import { Secret } from "./secret.ts";
import { keychainVaultService, SSM_META, SSM_PREFIX } from "../constants.ts";

// Where provisioned credentials live. Until the Sikrets platform vault ships, the default is AWS
// SSM Parameter Store, shared by everyone on the account; the OS keychain is the single-machine
// fallback. Values only ever cross this boundary wrapped in Secret. Anything bound for SSM is
// sealed on this machine first (see envelope.ts), so the account holds ciphertext it can't read;
// legacy plaintext parameters stay readable until `sikrets migrate encrypt` seals them.

export type VaultName = "ssm" | "keychain";

export interface Vault {
  readonly name: VaultName;
  put(key: string, value: Secret): Promise<void>;
  get(key: string): Promise<Secret | undefined>;
  delete(key: string): Promise<void>;
}

export interface VaultOptions {
  /** From sikrets.json "encryption": refuse legacy plaintext, so nobody can plant a value in SSM. */
  requireSealed?: boolean;
  /** Tests pass a fake; otherwise an SSMClient for the connected AWS profile. */
  client?: SsmClient;
}

const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const checkKey = (key: string) => {
  if (!KEY.test(key)) throw new Error(`Invalid vault key "${key}"`);
  return key;
};

const RESTORE_HINT = "This device doesn't have your data key. Restore it with: sikrets recovery restore";

function keychainVault(project: string): Vault {
  const service = keychainVaultService(project);
  return {
    name: "keychain",
    put: (key, value) => Bun.secrets.set({ service, name: checkKey(key), value: value.reveal() }),
    get: async (key) => {
      const v = await Bun.secrets.get({ service, name: checkKey(key) });
      return v ? Secret.of(v) : undefined;
    },
    delete: async (key) => void (await Bun.secrets.delete({ service, name: checkKey(key) })),
  };
}

// ── SSM, raw: parameters exactly as stored (envelopes or legacy plaintext) ──

/** The one method of SSMClient Sikrets uses. */
export interface SsmClient {
  send(command: object): Promise<any>;
}

export interface SsmParams {
  /** Full parameter name, which is also each value's associated data. */
  path(key: string): string;
  /** Every parameter directly under /sikrets/<project>/, keyed by vault key. */
  list(): Promise<Map<string, string>>;
  get(key: string): Promise<string | undefined>;
  put(key: string, stored: string): Promise<void>;
  /** Writes only if the parameter doesn't exist. False when something got there first. */
  create(key: string, stored: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Copies kept while a parameter is deleted and recreated (see migrate.ts), keyed by vault key. */
  staged(): Promise<Map<string, string>>;
  stage(key: string, stored: string): Promise<void>;
  unstage(key: string): Promise<void>;
  /** The data-key fingerprint the project is sealed under, if one has been claimed. */
  marker(): Promise<string | undefined>;
  /** Claims the project for this fingerprint unless one is already claimed; returns the one that holds. */
  claimMarker(fingerprint: string): Promise<string>;
}

export async function ssmParams(project: string, client?: SsmClient): Promise<SsmParams> {
  const { SSMClient, PutParameterCommand, GetParameterCommand, GetParametersByPathCommand, DeleteParameterCommand, ParameterNotFound, ParameterAlreadyExists } = await import("@aws-sdk/client-ssm");
  const c = client ?? new SSMClient(await awsClientConfig());
  const prefix = `${SSM_PREFIX}/${project}`;
  const path = (key: string) => `${prefix}/${checkKey(key)}`;
  const staging = (key: string) => `${path(key)}${SSM_META.stagedSuffix}`;
  const marker = `${prefix}/${SSM_META.dataKeyMarker}`;
  const missing = (error: unknown) => error instanceof ParameterNotFound || (error as { name?: string })?.name === "ParameterNotFound";
  const exists = (error: unknown) => error instanceof ParameterAlreadyExists || (error as { name?: string })?.name === "ParameterAlreadyExists";
  /** Every parameter directly under the prefix, by its name after the prefix. */
  async function all() {
    const out = new Map<string, string>();
    let NextToken: string | undefined;
    do {
      const page = await c.send(new GetParametersByPathCommand({ Path: prefix, Recursive: false, WithDecryption: true, NextToken }));
      for (const p of page.Parameters ?? []) if (p.Name && p.Value !== undefined) out.set(p.Name.slice(prefix.length + 1), p.Value);
      NextToken = page.NextToken;
    } while (NextToken);
    return out;
  }
  async function get(name: string) {
    try {
      return (await c.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value || undefined;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
  // Still a SecureString: KMS stays on as a second layer, it just no longer holds the only key.
  const put = async (name: string, stored: string, Overwrite = true) => void (await c.send(new PutParameterCommand({ Name: name, Value: stored, Type: "SecureString", Overwrite, Tier: "Standard" })));
  async function create(name: string, stored: string, Type: "SecureString" | "String" = "SecureString") {
    try {
      await c.send(new PutParameterCommand({ Name: name, Value: stored, Type, Overwrite: false, Tier: "Standard" }));
      return true;
    } catch (error) {
      if (exists(error)) return false;
      throw error;
    }
  }
  async function remove(name: string) {
    try {
      await c.send(new DeleteParameterCommand({ Name: name }));
    } catch (error) {
      if (!missing(error)) throw error; // already gone counts as done
    }
  }
  return {
    path,
    async list() {
      const out = new Map<string, string>();
      for (const [name, value] of await all()) if (KEY.test(name)) out.set(name, value);
      return out;
    },
    get: (key) => get(path(key)),
    put: (key, stored) => put(path(key), stored),
    create: (key, stored) => create(path(key), stored),
    delete: (key) => remove(path(key)),
    async staged() {
      const out = new Map<string, string>();
      for (const [name, value] of await all()) {
        const key = name.endsWith(SSM_META.stagedSuffix) ? name.slice(0, -SSM_META.stagedSuffix.length) : "";
        if (KEY.test(key)) out.set(key, value);
      }
      return out;
    },
    stage: (key, stored) => put(staging(key), stored),
    unstage: (key) => remove(staging(key)),
    marker: () => get(marker),
    async claimMarker(fingerprint) {
      // A plain String: a fingerprint reveals nothing, and anyone reading the project may check it.
      if (await create(marker, fingerprint, "String")) return fingerprint;
      return (await get(marker)) ?? fingerprint;
    },
  };
}

const MISMATCH_HINT = "This device's data key isn't the one this project's values are sealed with. Restore that key with: sikrets recovery restore --force";

/** Whether a sealed value in the project opens under `key`; undefined when there is none to try. */
async function opensExisting(params: SsmParams, key: Uint8Array): Promise<boolean | undefined> {
  for (const [name, stored] of await params.list()) {
    if (envelopeKind(stored) !== "sealed") continue;
    try {
      openValue(key, params.path(name), stored);
      return true;
    } catch {
      return false;
    }
  }
  return undefined;
}

/**
 * The project key for writing. The project records which data key it is sealed under (a marker
 * created once, with Overwrite: false), so two fresh devices can't each create a key and seal
 * values the other can't open: whichever claims the marker first wins, and the other is refused.
 */
export async function writeKey(project: string, params: SsmParams): Promise<Buffer> {
  const [claimed, existing] = [await params.marker(), await loadDataKey()];
  if (existing) {
    const mine = fingerprint(existing);
    if (claimed && claimed !== mine) throw new Error(MISMATCH_HINT);
    // Projects sealed before the marker existed: claim it only if this key opens what's there.
    if (!claimed && (await opensExisting(params, projectKey(existing, project))) === false) throw new Error(MISMATCH_HINT);
    if (!claimed && (await params.claimMarker(mine)) !== mine) throw new Error(MISMATCH_HINT);
    return projectKey(existing, project);
  }
  if (claimed) throw new Error(RESTORE_HINT);
  for (const stored of (await params.list()).values()) if (envelopeKind(stored) !== "plain") throw new Error(RESTORE_HINT);
  const created = await ensureDataKey();
  if ((await params.claimMarker(fingerprint(created))) !== fingerprint(created)) throw new Error(MISMATCH_HINT);
  return projectKey(created, project);
}

export async function ssmVault(project: string, opts: VaultOptions = {}): Promise<Vault> {
  const params = await ssmParams(project, opts.client);
  let key: Promise<Buffer> | undefined;
  const readKey = async () => {
    const dataKey = await loadDataKey();
    if (!dataKey) throw new Error(RESTORE_HINT);
    return projectKey(dataKey, project);
  };
  return {
    name: "ssm",
    put: async (k, value) => params.put(k, sealValue(await (key ??= writeKey(project, params)), params.path(k), value.reveal())),
    get: async (k) => {
      const stored = await params.get(k);
      if (stored === undefined) return undefined;
      if (envelopeKind(stored) === "plain") {
        if (opts.requireSealed) throw new Error(`${params.path(k)} is stored unencrypted, but this project requires encryption. Someone may have replaced it; check, then run: sikrets migrate encrypt`);
        return Secret.of(stored);
      }
      return Secret.of(openValue(await (key ??= readKey()), params.path(k), stored));
    },
    delete: (k) => params.delete(k),
  };
}

export const openVault = async (project: string, name: VaultName, opts: VaultOptions = {}): Promise<Vault> =>
  name === "ssm" ? ssmVault(project, opts) : keychainVault(project);

registerUndo("vault.delete", async ({ project, keys }, ctx) => {
  const vault = await openVault(project!, ctx.vault, ctx);
  for (const key of keys!.split(",")) await vault.delete(key);
});
