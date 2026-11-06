import { DeviceAuthError } from "./device-auth.ts";
import { ensureDataKey, loadDataKey } from "./datakey.ts";
import { envelopeKind, openValue, projectKey, sealValue } from "./envelope.ts";
import { registerUndo } from "./plan.ts";
import { readRecord } from "./recovery.ts";
import { Secret } from "./secret.ts";
import { connect, resolveServer, type Connection } from "./server.ts";
import { DEVICE_AUTH, SERVER } from "../constants.ts";

// Where values live: a Sikrets server (ours unless configured otherwise; see server.ts). Every
// value is sealed on this machine before it leaves (envelope.ts) and opened here after it comes
// back, so the server only ever holds ciphertext. Requests are signed by this device's key.
// Values only ever cross this boundary wrapped in Secret.

export interface Vault {
  /** The server holding the values. */
  readonly server: string;
  put(key: string, value: Secret): Promise<void>;
  /** Stores an envelope sealed elsewhere for this project and key, as is (sikrets migrate). */
  putSealed(key: string, envelope: string): Promise<void>;
  get(key: string): Promise<Secret | undefined>;
  /** Whether a value is stored, without fetching or decrypting it. */
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Every stored name (stand-ins included), sorted. */
  list(): Promise<string[]>;
}

export interface VaultOptions {
  environment?: string;
}

const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
export const isVaultKey = (key: string) => KEY.test(key);
const checkKey = (key: string) => {
  if (!KEY.test(key)) throw new Error(`Invalid vault key "${key}"`);
  return key;
};

const RESTORE_HINT = "This device doesn't have your data key, so it can't open or add to this vault. Restore it with your recovery code: sikrets recovery restore";

/** Opens the project's vault on `server` (default: the resolved server). Nothing is fetched until it is used. */
export async function openVault(project: string, server?: string, opts: VaultOptions = {}): Promise<Vault> {
  const where = server ?? (await resolveServer());
  const environment = opts.environment ?? SERVER.environment;
  const P = DEVICE_AUTH.paths;
  let connection: Promise<Connection> | undefined;
  const conn = () => (connection ??= connect(where));
  let names: Promise<Set<string>> | undefined;

  const send = async <T>(method: string, route: string, payload?: unknown, allowMissing = false) => {
    const { client, session } = await conn();
    return client.send<T>(session, method, route, payload, { allowMissing });
  };
  const stored = () =>
    (names ??= send<{ values: { name: string }[] }>("GET", P.values(project, environment)).then(
      (r) => new Set(r.values.map((v) => v.name)),
      (error) => {
        names = undefined;
        throw error;
      },
    ));

  const readKey = async () => {
    const dataKey = await loadDataKey();
    if (!dataKey) throw new Error(RESTORE_HINT);
    return projectKey(dataKey, project);
  };

  // A device without a data key creates one only when nothing says one already exists (no
  // recovery record, no values on the server). Otherwise it would quietly seal new values under a
  // key no other device holds, next to old ones it can't open.
  const writeKey = async () => {
    const existing = await loadDataKey();
    if (existing) return projectKey(existing, project);
    if ((await readRecord()) || (await stored()).size) throw new Error(RESTORE_HINT);
    return projectKey(await ensureDataKey(), project);
  };

  const upload = async (key: string, sealed: string) => {
    try {
      await send("PUT", P.value(project, environment, key), { value: sealed });
    } catch (error) {
      if (error instanceof DeviceAuthError && error.code === "too_large") throw new Error(`${key} is too large to store once encrypted (${Buffer.byteLength(sealed)} bytes): ${error.message}`);
      throw error;
    }
    (await stored()).add(key);
  };

  return {
    server: where,
    put: async (key, value) => upload(checkKey(key), sealValue(await writeKey(), project, key, value.reveal())),
    async putSealed(key, envelope) {
      if (envelopeKind(envelope) !== "sealed") throw new Error(`${key} isn't sealed; refusing to upload it as is`);
      await upload(checkKey(key), envelope);
    },
    async get(key) {
      const found = await send<{ value: string } | undefined>("GET", P.value(project, environment, checkKey(key)), undefined, true);
      if (!found) return undefined;
      return Secret.of(openValue(await readKey(), project, key, found.value));
    },
    has: async (key) => (await stored()).has(checkKey(key)),
    async delete(key) {
      await send("DELETE", P.value(project, environment, checkKey(key)));
      (await stored()).delete(key);
    },
    list: async () => [...(await stored())].sort(),
  };
}

registerUndo("vault.delete", async ({ project, keys }, ctx) => {
  const vault = await openVault(project!, ctx.server);
  for (const key of keys!.split(",")) await vault.delete(key);
});
