import os from "node:os";
import path from "node:path";
import { deviceDir, pointToJwk, type Device, type DeviceKind } from "./device.ts";
import { readJson, remove, writePrivate } from "./fs.ts";
import { createProof } from "./proof.ts";
import { DEVICE, DEVICE_AUTH } from "../constants.ts";

// Signing this device in to a Sikrets server, and talking to it afterwards. Sign-in follows the
// OAuth device flow (RFC 8628): register the device's public signing key, a person approves in a
// browser, the client polls until the server hands back a device id and certificate. Every request
// after that carries a fresh proof signed by the device key (proof.ts); there is no bearer token
// to steal. The approval step is a callback, so the real browser sign-in slots in later.

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
}

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
  ) {
    super(message);
  }
}

const sessionFile = () => path.join(deviceDir(), DEVICE.sessionFile);
export const readSession = () => readJson<DeviceSession | undefined>(sessionFile(), undefined);
export const writeSession = (s: DeviceSession) => writePrivate(sessionFile(), JSON.stringify(s, null, 2) + "\n");
export const clearSession = () => remove(sessionFile());

export interface ClientOptions {
  server: string;
  device: Device;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeviceClient {
  /** Registers this device and waits for a person to approve it. Doesn't write the session; the caller does. */
  login(opts: { name?: string; approve: (a: Approval) => Promise<void> | void; timeoutMs?: number }): Promise<DeviceSession>;
  me(session: DeviceSession): Promise<{ user: string; deviceId: string }>;
  devices(session: DeviceSession): Promise<DeviceInfo[]>;
  revoke(session: DeviceSession, id: string): Promise<void>;
}

export function deviceClient(opts: ClientOptions): DeviceClient {
  const http = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const base = opts.server.replace(/\/+$/, "");
  const jwk = pointToJwk(opts.device.signingPublicKey);
  const sign = (data: Uint8Array) => opts.device.sign(data);

  async function call<T>(method: string, route: string, who: { kid: string } | { jwk: JsonWebKey }, payload?: unknown): Promise<T> {
    const url = `${base}${route}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const proof = await createProof(sign, { method, url, body }, who, { now: now() });
    const res = await http(url, { method, body, headers: { [DEVICE_AUTH.proofHeader]: proof, ...(body ? { "content-type": "application/json" } : {}) } });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof data.error === "string" ? data.error : "error";
      const reason = typeof data.reason === "string" ? `: ${data.reason}` : "";
      throw new DeviceAuthError(res.status, code, `${base} refused the request (${res.status} ${code}${reason})`);
    }
    return data as T;
  }

  return {
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
