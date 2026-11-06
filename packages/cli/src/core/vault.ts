import { awsClientConfig } from "../providers/aws.ts";
import { ensureDataKey, loadDataKey } from "./datakey.ts";
import { envelopeKind, openValue, projectKey, sealValue } from "./envelope.ts";
import { registerUndo } from "./plan.ts";
import { readRecord } from "./recovery.ts";
import { Secret } from "./secret.ts";
import { keychainVaultService, SSM_PREFIX, SSM_STANDARD_MAX_BYTES } from "../constants.ts";

// Where provisioned credentials live. Until the Sikrets platform vault ships, the default is AWS
// SSM Parameter Store (IAM-controlled, shared by everyone on the account); the OS keychain is the
// single-machine fallback. Values only ever cross this boundary wrapped in Secret. Every value is
// sealed on this machine before it is stored (see envelope.ts), so neither AWS nor anything else
// reading the backend holds a key that opens it. Legacy plaintext is still read, then sealed in
// place on that first read.

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

const RESTORE_HINT = "This device doesn't have your data key, so it can't open or add to this vault. Restore it with your recovery code: sikrets recovery restore";

/** Values exactly as a backend holds them: envelopes, or legacy plaintext. */
interface RawStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, stored: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Whether any of the project's values is sealed; only backends that can list implement it. */
  anySealed?(): Promise<boolean>;
  maxBytes?: number;
}

function keychainStore(project: string): RawStore {
  const service = keychainVaultService(project);
  return {
    get: async (key) => (await Bun.secrets.get({ service, name: key })) || undefined,
    put: (key, stored) => Bun.secrets.set({ service, name: key, value: stored }),
    delete: async (key) => void (await Bun.secrets.delete({ service, name: key })),
  };
}

async function ssmStore(project: string, client?: SsmClient): Promise<RawStore> {
  const { SSMClient, PutParameterCommand, GetParameterCommand, GetParametersByPathCommand, DeleteParameterCommand, ParameterNotFound } = await import("@aws-sdk/client-ssm");
  const c: SsmClient = client ?? new SSMClient(await awsClientConfig());
  const prefix = `${SSM_PREFIX}/${project}`;
  const path = (key: string) => `${prefix}/${key}`;
  const missing = (error: unknown) => error instanceof ParameterNotFound || (error as { name?: string })?.name === "ParameterNotFound";
  return {
    maxBytes: SSM_STANDARD_MAX_BYTES,
    async get(key) {
      try {
        return (await c.send(new GetParameterCommand({ Name: path(key), WithDecryption: true }))).Parameter?.Value || undefined;
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
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
    async anySealed() {
      let NextToken: string | undefined;
      do {
        const page = await c.send(new GetParametersByPathCommand({ Path: prefix, Recursive: false, WithDecryption: true, NextToken }));
        if ((page.Parameters ?? []).some((p: { Value?: string }) => p.Value && envelopeKind(p.Value) !== "plain")) return true;
        NextToken = page.NextToken;
      } while (NextToken);
      return false;
    },
  };
}

function sealedVault(project: string, name: VaultName, store: RawStore): Vault {
  const readKey = async () => {
    const dataKey = await loadDataKey();
    if (!dataKey) throw new Error(RESTORE_HINT);
    return projectKey(dataKey, project);
  };

  // A device without a data key creates one only when nothing says one already exists (no
  // recovery record, no sealed values). Otherwise it would quietly seal new values under a key
  // no other device holds, next to old ones it can't open.
  const writeKey = async (key: string) => {
    const existing = await loadDataKey();
    if (existing) return projectKey(existing, project);
    const current = await store.get(key);
    if ((await readRecord()) || (current && envelopeKind(current) !== "plain") || (await store.anySealed?.())) throw new Error(RESTORE_HINT);
    return projectKey(await ensureDataKey(), project);
  };

  const write = async (key: string, plaintext: string) => {
    const stored = sealValue(await writeKey(key), project, key, plaintext);
    const size = Buffer.byteLength(stored);
    if (store.maxBytes && size > store.maxBytes) {
      throw new Error(`${key} is too large for the ${name} vault once encrypted (${size} of ${store.maxBytes} bytes). Values up to about 3 KB fit; use the keychain vault for larger ones`);
    }
    await store.put(key, stored);
  };

  return {
    name,
    put: (key, value) => write(checkKey(key), value.reveal()),
    async get(key) {
      const stored = await store.get(checkKey(key));
      if (stored === undefined) return undefined;
      if (envelopeKind(stored) === "plain") {
        // Written before client-side encryption: still readable, and sealed in place now. Best
        // effort, so a read-only role or a missing data key still gets the value.
        await write(key, stored).catch(() => {});
        return Secret.of(stored);
      }
      return Secret.of(openValue(await readKey(), project, key, stored));
    },
    has: async (key) => (await store.get(checkKey(key))) !== undefined,
    delete: (key) => store.delete(checkKey(key)),
  };
}

export const openVault = async (project: string, name: VaultName, opts: VaultOptions = {}): Promise<Vault> =>
  sealedVault(project, name, name === "ssm" ? await ssmStore(project, opts.ssm) : keychainStore(project));

registerUndo("vault.delete", async ({ project, keys }, ctx) => {
  const vault = await openVault(project!, ctx.vault);
  for (const key of keys!.split(",")) await vault.delete(key);
});
