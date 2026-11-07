import { DeviceAuthError } from "./device-auth.ts";
import { ensureDataKey, fingerprint, loadDataKey } from "./datakey.ts";
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
  /** Stores an envelope sealed elsewhere for this project and key, as is (sikrets migrate); it must open with this device's key. */
  putSealed(key: string, envelope: string): Promise<void>;
  /**
   * Create-only versions (sikrets migrate): false, and nothing written, when the server already
   * holds a value under that name, so a value written there meanwhile is never overwritten.
   */
  create(key: string, value: Secret): Promise<boolean>;
  createSealed(key: string, envelope: string): Promise<boolean>;
  /** Opens an envelope for this project and key with this device's key; throws if it doesn't open. */
  open(key: string, envelope: string): Promise<Secret>;
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
const MISMATCH_HINT = "This project is sealed with a different data key than this device's, so nothing was written. Restore that key on this device with your recovery code: sikrets recovery restore --force";

const isMismatch = (error: unknown) => error instanceof DeviceAuthError && error.code === DEVICE_AUTH.dataKeyMismatch;

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

  /** The fingerprint the server says this project's values are sealed under, if it has one. */
  let claimed: Promise<string | undefined> | undefined;
  const claimedFingerprint = () =>
    (claimed ??= send<{ fingerprint: string } | undefined>("GET", P.dataKey(project), undefined, true).then(
      (r) => r?.fingerprint,
      (error) => {
        claimed = undefined;
        throw error;
      },
    ));

  /** Whether a stored value opens under `key`; undefined when there is none to try. */
  const opensExisting = async (key: Buffer): Promise<boolean | undefined> => {
    for (const name of [...(await stored())].sort()) {
      const found = await send<{ value: string } | undefined>("GET", P.value(project, environment, name), undefined, true);
      if (!found || envelopeKind(found.value) !== "sealed") continue;
      try {
        openValue(key, project, name, found.value);
        return true;
      } catch {
        return false;
      }
    }
    return undefined;
  };

  // The key to write with, checked against the project's data-key claim on the server before the
  // first write (and claimed if the project has none), so two devices that each made a key can't
  // both seal values here: the server keeps the first fingerprint and refuses the other. A device
  // without a data key makes one only for a project nothing says is sealed yet (no claim, no
  // recovery record, no values); `create` is false for envelopes sealed elsewhere.
  let writer: Promise<{ key: Buffer; fingerprint: string }> | undefined;
  const writeKey = (create = true) =>
    (writer ??= (async () => {
      let dataKey = await loadDataKey();
      const held = await claimedFingerprint();
      if (!dataKey) {
        if (!create || held || (await readRecord()) || (await stored()).size) throw new Error(RESTORE_HINT);
        dataKey = await ensureDataKey();
      }
      const mine = fingerprint(dataKey);
      if (held && held !== mine) throw new Error(MISMATCH_HINT);
      const key = projectKey(dataKey, project);
      if (!held) {
        // Values stored before claims existed: claim only with the key they open under.
        if ((await opensExisting(key)) === false) throw new Error(MISMATCH_HINT);
        try {
          await send("PUT", P.dataKey(project), { fingerprint: mine });
        } catch (error) {
          if (isMismatch(error)) throw new Error(MISMATCH_HINT);
          throw error;
        }
        claimed = Promise.resolve(mine);
      }
      return { key, fingerprint: mine };
    })().catch((error) => {
      writer = undefined;
      throw error;
    }));

  const upload = async (key: string, sealed: string, dataKey: string, ifAbsent = false): Promise<boolean> => {
    try {
      await send("PUT", P.value(project, environment, key), { value: sealed, dataKey, ...(ifAbsent ? { ifAbsent: true } : {}) });
    } catch (error) {
      if (isMismatch(error)) throw new Error(MISMATCH_HINT);
      if (error instanceof DeviceAuthError && error.code === "too_large") throw new Error(`${key} is too large to store once encrypted (${Buffer.byteLength(sealed)} bytes): ${error.message}`);
      if (ifAbsent && error instanceof DeviceAuthError && error.status === 412) return false;
      throw error;
    }
    (await stored()).add(key);
    return true;
  };
  const seal = async (key: string, value: Secret, ifAbsent = false) => {
    const w = await writeKey();
    return upload(key, sealValue(w.key, project, key, value.reveal()), w.fingerprint, ifAbsent);
  };
  const sealedOnly = (key: string, envelope: string) => {
    if (envelopeKind(envelope) !== "sealed") throw new Error(`${key} isn't sealed; refusing to upload it as is`);
    return envelope;
  };

  return {
    server: where,
    put: async (key, value) => void (await seal(checkKey(key), value)),
    putSealed: async (key, envelope) => void (await upload(checkKey(key), sealedOnly(key, envelope), (await writeKey(false)).fingerprint)),
    create: async (key, value) => seal(checkKey(key), value, true),
    createSealed: async (key, envelope) => upload(checkKey(key), sealedOnly(key, envelope), (await writeKey(false)).fingerprint, true),
    open: async (key, envelope) => Secret.of(openValue(await readKey(), project, checkKey(key), envelope)),
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
