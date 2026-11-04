import { awsClientConfig } from "../providers/aws.ts";
import type { TemporaryCredentials } from "../cloud/types.ts";
import { ensureDataKey, loadDataKey } from "./datakey.ts";
import { envelopeKind, openValue, projectKey, sealValue } from "./envelope.ts";
import { registerUndo } from "./plan.ts";
import { Secret } from "./secret.ts";
import { keychainVaultService, SSM_PREFIX } from "../constants.ts";

// Where provisioned credentials live. Until the Sikrets platform vault ships, the default is AWS
// SSM Parameter Store, shared by everyone on the account; the OS keychain is the single-machine
// fallback. Values only ever cross this boundary wrapped in Secret. Anything bound for SSM is
// sealed on this machine first (see envelope.ts), so the account holds ciphertext it can't read;
// legacy plaintext parameters stay readable until `sikrets migrate encrypt` seals them.
// A cloud vault ("aws") is the secret store of your self-hosted Sikrets stack (`sikrets cloud
// connect`, see cloud/types.ts): the same sealed values, readable by agents only through their own
// cloud identities.

export type VaultName = "ssm" | "keychain" | "aws";
export const VAULT_NAMES: readonly VaultName[] = ["ssm", "keychain", "aws"];
/** Vaults that store values off this machine, and so hold only sealed (sk1:) envelopes. */
export const isRemoteVault = (name: VaultName) => name !== "keychain";
/** Vaults that live in a self-hosted Sikrets stack; the name is the cloud's id. */
export const isCloudVault = (name: VaultName): name is "aws" => name === "aws";

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
  /** Cloud vaults: read with an agent's temporary credentials instead of yours. */
  as?: TemporaryCredentials;
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
  delete(key: string): Promise<void>;
}

export async function ssmParams(project: string, client?: SsmClient, keyId?: string): Promise<SsmParams> {
  // SsmParams is the SecretStore shape cloud providers return, so the sealing below works on any of them.
  const { SSMClient, PutParameterCommand, GetParameterCommand, GetParametersByPathCommand, DeleteParameterCommand, ParameterNotFound } = await import("@aws-sdk/client-ssm");
  const c = client ?? new SSMClient(await awsClientConfig());
  const prefix = `${SSM_PREFIX}/${project}`;
  const path = (key: string) => `${prefix}/${checkKey(key)}`;
  const missing = (error: unknown) => error instanceof ParameterNotFound || (error as { name?: string })?.name === "ParameterNotFound";
  return {
    path,
    async list() {
      const out = new Map<string, string>();
      let NextToken: string | undefined;
      do {
        const page = await c.send(new GetParametersByPathCommand({ Path: prefix, Recursive: false, WithDecryption: true, NextToken }));
        for (const p of page.Parameters ?? []) {
          const key = p.Name?.slice(prefix.length + 1);
          if (key && KEY.test(key) && p.Value !== undefined) out.set(key, p.Value);
        }
        NextToken = page.NextToken;
      } while (NextToken);
      return out;
    },
    async get(key) {
      try {
        return (await c.send(new GetParameterCommand({ Name: path(key), WithDecryption: true }))).Parameter?.Value || undefined;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    },
    // Still a SecureString: KMS stays on as a second layer, it just no longer holds the only key.
    put: async (key, stored) => void (await c.send(new PutParameterCommand({ Name: path(key), Value: stored, Type: "SecureString", Overwrite: true, Tier: "Standard", ...(keyId ? { KeyId: keyId } : {}) }))),
    async delete(key) {
      try {
        await c.send(new DeleteParameterCommand({ Name: path(key) }));
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },
  };
}

/**
 * The project key for writing. A device without a data key only creates one when the project has
 * no sealed values yet; otherwise it would quietly seal new values under a key nobody else holds.
 */
export async function writeKey(project: string, params: SsmParams): Promise<Buffer> {
  const existing = await loadDataKey();
  if (existing) return projectKey(existing, project);
  for (const stored of (await params.list()).values()) if (envelopeKind(stored) !== "plain") throw new Error(RESTORE_HINT);
  return projectKey(await ensureDataKey(), project);
}

/** Raw store for a remote vault: Parameter Store via your connected profile (ssm), or your cloud stack's secret store. */
export async function vaultParams(project: string, name: VaultName, opts: VaultOptions = {}): Promise<SsmParams> {
  if (!isCloudVault(name) || opts.client) return ssmParams(project, opts.client);
  const { cloudProvider } = await import("../cloud/index.ts");
  return (await cloudProvider(name)).secretStore(project, opts.as ? { as: opts.as } : {});
}

export async function ssmVault(project: string, opts: VaultOptions = {}, name: VaultName = "ssm"): Promise<Vault> {
  const params = await vaultParams(project, name, opts);
  let key: Promise<Buffer> | undefined;
  const readKey = async () => {
    const dataKey = await loadDataKey();
    if (!dataKey) throw new Error(RESTORE_HINT);
    return projectKey(dataKey, project);
  };
  return {
    name,
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
  isRemoteVault(name) ? ssmVault(project, opts, name) : keychainVault(project);

registerUndo("vault.delete", async ({ project, keys }, ctx) => {
  const vault = await openVault(project!, ctx.vault, ctx);
  for (const key of keys!.split(",")) await vault.delete(key);
});
