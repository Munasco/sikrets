import os from "node:os";
import path from "node:path";
import { configDir } from "../store.ts";
import { loadDataKey, saveDataKey } from "./datakey.ts";
import { deviceDir, pointToJwk, replaceDevice, type Device, type DeviceKind } from "./device.ts";
import { readJson, remove, writePrivate } from "./fs.ts";
import { createProof } from "./proof.ts";
import { DEVICE, DEVICE_AUTH } from "../constants.ts";

// Signing this device in to a Sikrets server, and talking to it afterwards. Sign-in follows the
// OAuth device flow (RFC 8628): register the device's public signing key, a person approves in a
// browser, the client polls until the server hands back a device id and certificate. Every request
// after that carries a fresh proof signed by the device key (proof.ts); there is no bearer token
// to steal. The approval step is a callback, so the real browser sign-in slots in later.
//
// A device can be signed in to several servers (ours, a company's, `sikrets server` on this Mac);
// session.json keeps one sign-in per server and remembers the last one `sikrets login` used.

export interface DeviceSession {
  version: 1;
  server: string;
  deviceId: string;
  user: string;
  /** Server-signed binding of the device id to this device's key. */
  certificate: string;
  kind: DeviceKind;
  hardwareBound: boolean;
  signedInAt: string;
  /** Every device id this key holds on this server, this one included; logout revokes them all. */
  registrations?: string[];
}

/** The ids a session's key holds: its own, plus earlier ones not revoked yet. */
export const registrationsOf = (s: DeviceSession) => [...new Set([...(s.registrations ?? []), s.deviceId])];

export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
  hardwareBound: boolean;
  registeredAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** What a person needs to approve this device: where to go and the code to check there. */
export interface Approval {
  url: string;
  userCode: string;
}

export class DeviceAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The server's reason, e.g. "key revoked". */
    readonly reason?: string,
  ) {
    super(message);
  }
}

interface SessionFile {
  version: 2;
  /** The server `sikrets login` last signed in to: the profile's saved server. */
  current?: string;
  sessions: Record<string, DeviceSession>;
}

const sessionFile = () => path.join(deviceDir(), DEVICE.sessionFile);
export const normalizeServer = (url: string) => url.replace(/\/+$/, "");

async function readSessions(): Promise<SessionFile> {
  const raw = await readJson<SessionFile | DeviceSession | undefined>(sessionFile(), undefined);
  if (!raw) return { version: 2, sessions: {} };
  // Before per-server sessions the file held a single one.
  if (raw.version === 1) return { version: 2, current: raw.server, sessions: { [raw.server]: raw } };
  return raw;
}

const writeSessions = async (f: SessionFile) => {
  if (!Object.keys(f.sessions).length) return remove(sessionFile());
  await writePrivate(sessionFile(), JSON.stringify(f, null, 2) + "\n");
};

/** The sign-in for `server`, or for the profile's saved server when none is named. */
export async function readSession(server?: string): Promise<DeviceSession | undefined> {
  const f = await readSessions();
  const key = server ? normalizeServer(server) : f.current;
  return key ? f.sessions[key] : undefined;
}

/** Saves a sign-in. `remember` makes its server the profile's saved one (what `sikrets login` does). */
export async function writeSession(s: DeviceSession, opts: { remember?: boolean } = { remember: true }) {
  const f = await readSessions();
  const key = normalizeServer(s.server);
  f.sessions[key] = { ...s, server: key };
  if (opts.remember) f.current = key;
  await writeSessions(f);
}

/** Forgets the sign-in for `server` (default: the saved one). */
export async function clearSession(server?: string) {
  const f = await readSessions();
  const key = server ? normalizeServer(server) : f.current;
  if (key) delete f.sessions[key];
  if (f.current === key) f.current = undefined;
  await writeSessions(f);
}

/** The server `sikrets login` last signed in to. */
export const savedServer = async () => (await readSessions()).current;

/** How requests leave the CLI. Tests point it at an in-process server; nothing else changes it. */
export const transport = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
};

// Sign-ins left behind when this device's keys were replaced (restore --force): the old keys can't
// sign any more, so a later sign-in on the same server revokes them instead.
interface Retired {
  server: string;
  ids: string[];
}
const retiredFile = () => path.join(configDir(), DEVICE.retiredFile);
export const readRetired = () => readJson<Retired[]>(retiredFile(), []);
const writeRetired = (all: Retired[]) => (all.length ? writePrivate(retiredFile(), JSON.stringify(all, null, 2) + "\n") : remove(retiredFile()));

/** Records a session whose keys are about to be replaced, so its ids aren't left active and forgotten. */
export async function retireSession(s: DeviceSession) {
  const all = await readRetired();
  const mine = all.find((r) => r.server === s.server);
  const ids = [...new Set([...(mine?.ids ?? []), ...registrationsOf(s)])];
  await writeRetired([...all.filter((r) => r.server !== s.server), { server: s.server, ids }]);
}

/** Revokes `ids` one by one; an id the server no longer knows counts as done. Returns the ones that failed. */
export async function revokeAll(client: DeviceClient, session: DeviceSession, ids: readonly string[]): Promise<{ failed: string[]; errors: string[] }> {
  const failed: string[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    try {
      await client.revoke(session, id);
    } catch (error) {
      if (error instanceof DeviceAuthError && error.status === 404) continue;
      failed.push(id);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { failed, errors };
}

/**
 * After a sign-in: revokes the sign-ins left by this device's replaced keys, using the new session.
 * This key's own earlier sign-ins need nothing: the server replaces them when the key signs in
 * again (and revoking one would revoke the key, this sign-in included). What couldn't be revoked
 * stays recorded for next time.
 */
export async function revokeStale(client: DeviceClient, session: DeviceSession, _previous?: DeviceSession): Promise<DeviceSession> {
  const all = await readRetired();
  const retired = (all.find((r) => r.server === session.server)?.ids ?? []).filter((id) => id !== session.deviceId);
  const { failed } = await revokeAll(client, session, retired);
  await writeRetired([...all.filter((r) => r.server !== session.server), ...(failed.length ? [{ server: session.server, ids: failed }] : [])]);
  return { ...session, registrations: [session.deviceId] };
}

/**
 * New device keys for this device, with the data key re-wrapped to them (a server refuses the old
 * key for good once it was revoked). Every sign-in made with the old keys is recorded so the next
 * login to its server revokes it. The old keys are kept until the data key is saved under the new.
 */
export async function rotateDeviceKeys(): Promise<Device> {
  const key = await loadDataKey();
  const sessions = await allSessions();
  const device = await replaceDevice(async (fresh) => {
    if (key) await saveDataKey(key);
    return fresh;
  });
  for (const s of sessions) await retireSession(s);
  return device;
}

/** Every saved sign-in, on every server. */
export const allSessions = async () => Object.values((await readSessions()).sessions);

export interface ClientOptions {
  server: string;
  device: Device;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ServerInfo {
  service: string;
  apiVersion: number;
  approval: "auto" | "manual";
}

export interface DeviceClient {
  /** What the server is and how it approves sign-ins. Unsigned. */
  info(): Promise<ServerInfo>;
  /** A signed request as this device. Resolves to undefined for 404 when `allowMissing`. */
  send<T>(session: DeviceSession, method: string, route: string, payload?: unknown, opts?: { allowMissing?: boolean }): Promise<T>;
  /** Registers this device and waits for a person to approve it. Doesn't write the session; the caller does. */
  login(opts: { name?: string; approve: (a: Approval) => Promise<void> | void; timeoutMs?: number }): Promise<DeviceSession>;
  me(session: DeviceSession): Promise<{ user: string; deviceId: string }>;
  devices(session: DeviceSession): Promise<DeviceInfo[]>;
  revoke(session: DeviceSession, id: string): Promise<void>;
}

export function deviceClient(opts: ClientOptions): DeviceClient {
  const http = opts.fetch ?? transport.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const base = opts.server.replace(/\/+$/, "");
  const jwk = pointToJwk(opts.device.signingPublicKey);
  const sign = (data: Uint8Array) => opts.device.sign(data);

  async function call<T>(method: string, route: string, who: { kid: string } | { jwk: JsonWebKey }, payload?: unknown, allowMissing = false): Promise<T> {
    const url = `${base}${route}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const proof = await createProof(sign, { method, url, body }, who, { now: now() });
    let res: Response;
    try {
      res = await http(url, { method, body, headers: { [DEVICE_AUTH.proofHeader]: proof, ...(body ? { "content-type": "application/json" } : {}) } });
    } catch (error) {
      throw new DeviceAuthError(0, "unreachable", `Can't reach the Sikrets server at ${base} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (allowMissing && res.status === 404) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof data.error === "string" ? data.error : "error";
      const reason = typeof data.reason === "string" ? data.reason : undefined;
      throw new DeviceAuthError(res.status, code, `${base} refused the request (${res.status} ${code}${reason ? `: ${reason}` : ""})`, reason);
    }
    return data as T;
  }

  return {
    async info() {
      let res: Response;
      try {
        res = await http(`${base}${DEVICE_AUTH.paths.info}`, { method: "GET" });
      } catch (error) {
        throw new DeviceAuthError(0, "unreachable", `Can't reach the Sikrets server at ${base} (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!res.ok) throw new DeviceAuthError(res.status, "error", `${base} doesn't look like a Sikrets server (${res.status})`);
      return (await res.json()) as ServerInfo;
    },
    send: (s, method, route, payload, o) => call(method, route, { kid: s.deviceId }, payload, o?.allowMissing),
    async login({ name = os.hostname(), approve, timeoutMs = DEVICE_AUTH.approvalTimeoutMs }) {
      const { kind } = opts.device.meta;
      const hardwareBound = opts.device.hardwareBound;
      const started = await call<{ requestId: string; userCode: string; verificationUri: string; interval?: number }>("POST", DEVICE_AUTH.paths.authorize, { jwk }, { name, kind, hardwareBound, publicKey: jwk });
      await approve({ url: started.verificationUri, userCode: started.userCode });
      const deadline = now() + timeoutMs;
      const interval = (started.interval ?? DEVICE_AUTH.pollIntervalMs / 1000) * 1000;
      for (;;) {
        try {
          const done = await call<{ deviceId: string; user: string; certificate: string }>("POST", DEVICE_AUTH.paths.token, { jwk }, { requestId: started.requestId });
          return { version: 1, server: base, ...done, kind, hardwareBound, signedInAt: new Date(now()).toISOString() };
        } catch (error) {
          if (!(error instanceof DeviceAuthError && error.code === DEVICE_AUTH.pending)) throw error;
        }
        if (now() > deadline) throw new Error("Nobody approved this device in time. Run sikrets login again");
        await sleep(interval);
      }
    },
    me: (s) => call("GET", DEVICE_AUTH.paths.me, { kid: s.deviceId }),
    devices: async (s) => (await call<{ devices: DeviceInfo[] }>("GET", DEVICE_AUTH.paths.devices, { kid: s.deviceId })).devices,
    revoke: async (s, id) => void (await call("POST", DEVICE_AUTH.paths.revoke(id), { kid: s.deviceId })),
  };
}
