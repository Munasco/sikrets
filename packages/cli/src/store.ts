import path from "node:path";
import { readJson, withLock, writePrivate } from "./core/fs.ts";
import { ENV, FILES, KEYCHAIN_SERVICE, USER_DIR } from "./constants.ts";

export const configDir = () => Bun.env[ENV.configDir] || path.join(Bun.env.HOME ?? "", USER_DIR);

// Passwords live in the OS keychain (Keychain on macOS, libsecret on Linux, Credential Manager
// on Windows) via Bun.secrets. They are never written to disk by Sikrets.
const SERVICE = KEYCHAIN_SERVICE;

export const keychain = {
  set: (provider: string, account: string, value: string) => Bun.secrets.set({ service: `${SERVICE}.${provider}`, name: account, value }),
  get: (provider: string, account: string) => Bun.secrets.get({ service: `${SERVICE}.${provider}`, name: account }),
  delete: (provider: string, account: string) => Bun.secrets.delete({ service: `${SERVICE}.${provider}`, name: account }),
};

// Non-secret record of which providers are connected and how.
export interface Connection {
  provider: string;
  account: string;
  mode: "watch" | "terminal" | "profile";
  connectedAt: string;
  /** API keys Sikrets minted at the provider, by name (never the value), so none is lost track of. */
  keys?: MintedKey[];
}

/**
 * minting:    recorded before the key is created; it may exist at the provider with its value lost.
 * active:     verified and saved to the keychain; the one Sikrets uses.
 * superseded: replaced by a newer key (or another account); still valid until revoked in the dashboard.
 * failed:     created but the provider rejected it; revoke it in the dashboard.
 * revoked:    the person confirmed it is revoked (sikrets connect --revoked); kept for the record.
 */
export type MintedKeyStatus = "minting" | "active" | "superseded" | "failed" | "revoked";
export interface MintedKey {
  name: string;
  account: string;
  status: MintedKeyStatus;
  at: string;
}

const KEY_NEXT: Record<MintedKeyStatus, readonly MintedKeyStatus[]> = {
  minting: ["active", "failed", "revoked"],
  active: ["superseded"],
  superseded: ["revoked"],
  failed: ["revoked"],
  revoked: [],
};

export function moveKey(key: MintedKey, to: MintedKeyStatus): MintedKey {
  if (!KEY_NEXT[key.status].includes(to)) throw new Error(`API key ${key.name} is ${key.status}; it can't become ${to}`);
  return { ...key, status: to, at: new Date().toISOString() };
}

/** Keys still valid at the provider that Sikrets no longer uses: the person should revoke them. */
export const keysToRevoke = (c: Connection | undefined) => (c?.keys ?? []).filter((k) => k.status !== "active" && k.status !== "revoked");

const connectionsFile = () => path.join(configDir(), FILES.connections);

export const listConnections = () => readJson<Connection[]>(connectionsFile(), []);

/** Read-modify-write of one provider's connection under a lock, so parallel connects don't lose each other's records. */
export async function updateConnection(provider: string, change: (current: Connection | undefined) => Connection) {
  await withLock(connectionsFile(), async () => {
    const all = await listConnections();
    const next = change(all.find((c) => c.provider === provider));
    await writePrivate(connectionsFile(), JSON.stringify([...all.filter((c) => c.provider !== provider), next], null, 2) + "\n");
  });
}

export const saveConnection = (connection: Connection) => updateConnection(connection.provider, (current) => ({ ...connection, ...(current?.keys ? { keys: current.keys } : {}) }));
