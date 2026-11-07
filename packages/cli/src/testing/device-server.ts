import { generateKeyPairSync, randomBytes, sign as signWith } from "node:crypto";
import { jwkThumbprint, NonceStore, ProofError, signJws, verifyProof, type ProofHeader } from "../core/proof.ts";
import type { DeviceInfo } from "../core/device-auth.ts";
import type { DeviceKind } from "../core/device.ts";
import { DEVICE_AUTH } from "../constants.ts";

// A local stand-in for the Sikrets server's device endpoints, until the hosted one exists. Tests
// start it on a random port; `bun src/testing/device-server.ts` runs it on the default port with
// every sign-in approved automatically, for trying `sikrets login` by hand. State is in memory.
//
// It takes the client's word for whether a key is hardware-bound; the real server will need
// attestation for that.

interface Pending {
  jwk: JsonWebKey;
  jkt: string;
  name: string;
  kind: DeviceKind;
  hardwareBound: boolean;
  userCode: string;
  expiresAt: number;
  approvedBy?: string;
}

interface Registered extends DeviceInfo {
  jwk: JsonWebKey;
  user: string;
}

export interface FakeServer {
  url: string;
  /** What the browser approval page will do: approve a pending sign-in by its user code. */
  approve(userCode: string, user?: string): void;
  devices(): readonly Registered[];
  stop(): void;
}

export interface FakeServerOptions {
  port?: number;
  /** Approve every sign-in as this user straight away. */
  autoApprove?: string;
  now?: () => number;
}

const DEFAULT_USER = "you@localhost";

export function startDeviceServer(opts: FakeServerOptions = {}): FakeServer {
  const now = opts.now ?? Date.now;
  const nonces = new NonceStore();
  const pending = new Map<string, Pending>();
  const devices = new Map<string, Registered>();
  const serverKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const P = DEVICE_AUTH.paths;
  const [revokeHead, revokeTail] = P.revoke("ID").split("ID") as [string, string];

  const reply = (status: number, body: unknown) => Response.json(body, { status });
  const deny = (error: string, reason?: string, status = 401) => reply(status, { error, ...(reason ? { reason } : {}) });

  /** Checks the proof; a kid must name a live device, a jwk is only accepted where `allowJwk`. */
  function check(req: Request, body: string, allowJwk: boolean) {
    return verifyProof(req.headers.get(DEVICE_AUTH.proofHeader), {
      method: req.method,
      url: req.url,
      body,
      nonces,
      now: now(),
      keyFor(header: ProofHeader) {
        if (header.kid) {
          const d = devices.get(header.kid);
          if (!d) throw new ProofError("unknown device");
          if (d.revokedAt) throw new ProofError("device revoked");
          return d.jwk;
        }
        if (allowJwk && header.jwk?.kty === "EC" && header.jwk.crv === "P-256") return header.jwk;
        throw new ProofError("no device key");
      },
    });
  }

  const userCode = () => {
    const raw = randomBytes(DEVICE_AUTH.userCodeChars).map((b) => "BCDFGHJKLMNPQRSTVWXZ".charCodeAt(b % 20));
    const text = Buffer.from(raw).toString();
    return `${text.slice(0, 4)}-${text.slice(4)}`;
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = await req.text();
    const input = (body ? JSON.parse(body) : {}) as Record<string, any>;

    // The approval page. The real one is a signed-in browser session; this one trusts the caller.
    if (url.pathname === P.approve) {
      const entry = [...pending.values()].find((p) => p.userCode === (url.searchParams.get("code") ?? input.code));
      if (!entry) return deny("not_found", undefined, 404);
      entry.approvedBy = url.searchParams.get("user") ?? input.user ?? DEFAULT_USER;
      return reply(200, { approved: true });
    }

    let proof;
    try {
      proof = check(req, body, url.pathname === P.authorize || url.pathname === P.token);
    } catch (error) {
      if (error instanceof ProofError) return deny("invalid_proof", error.reason);
      throw error;
    }

    if (req.method === "POST" && url.pathname === P.authorize) {
      const jwk = proof.header.jwk!;
      if (jwkThumbprint(input.publicKey ?? {}) !== jwkThumbprint(jwk)) return deny("invalid_request", "the proof isn't signed by the key being registered", 400);
      const requestId = `${DEVICE_AUTH.requestIdPrefix}${randomBytes(9).toString("base64url")}`;
      const entry: Pending = { jwk, jkt: jwkThumbprint(jwk), name: String(input.name ?? "device"), kind: input.kind === "secure-enclave" ? "secure-enclave" : "software", hardwareBound: input.hardwareBound === true, userCode: userCode(), expiresAt: now() + DEVICE_AUTH.approvalTimeoutMs, approvedBy: opts.autoApprove };
      pending.set(requestId, entry);
      return reply(200, { requestId, userCode: entry.userCode, verificationUri: `${url.origin}${P.approve}?code=${entry.userCode}`, interval: DEVICE_AUTH.pollIntervalMs / 1000, expiresIn: DEVICE_AUTH.approvalTimeoutMs / 1000 });
    }

    if (req.method === "POST" && url.pathname === P.token) {
      const entry = pending.get(String(input.requestId));
      if (!entry) return deny("invalid_grant", undefined, 400);
      // Only the key that started the sign-in can collect it.
      if (jwkThumbprint(proof.header.jwk!) !== entry.jkt) return deny("invalid_grant", "a different key started this sign-in", 400);
      if (entry.expiresAt < now()) return deny("expired_token", undefined, 400);
      if (!entry.approvedBy) return deny(DEVICE_AUTH.pending, undefined, 400);
      pending.delete(String(input.requestId));
      const id = `${DEVICE_AUTH.deviceIdPrefix}${randomBytes(9).toString("base64url")}`;
      const at = new Date(now()).toISOString();
      devices.set(id, { id, name: entry.name, kind: entry.kind, hardwareBound: entry.hardwareBound, registeredAt: at, jwk: entry.jwk, user: entry.approvedBy });
      const certificate = await signJws(async (d) => signWith("sha256", d, { key: serverKey, dsaEncoding: "ieee-p1363" }), { typ: DEVICE_AUTH.certificateType, alg: DEVICE_AUTH.alg }, { sub: id, user: entry.approvedBy, cnf: { jkt: entry.jkt }, hw: entry.hardwareBound, iat: Math.floor(now() / 1000) });
      return reply(200, { deviceId: id, user: entry.approvedBy, certificate });
    }

    // Everything below needs a registered device.
    const me = proof.header.kid ? devices.get(proof.header.kid) : undefined;
    if (!me) return deny("invalid_proof", "no device key");
    me.lastSeenAt = new Date(now()).toISOString();
    const visible = ({ jwk: _jwk, user: _user, ...d }: Registered): DeviceInfo => d;

    if (req.method === "GET" && url.pathname === P.me) return reply(200, { user: me.user, deviceId: me.id });
    if (req.method === "GET" && url.pathname === P.devices) return reply(200, { devices: [...devices.values()].filter((d) => d.user === me.user).map(visible) });
    const revoke = url.pathname.startsWith(revokeHead) && url.pathname.endsWith(revokeTail) ? url.pathname.slice(revokeHead.length, -revokeTail.length) : undefined;
    if (req.method === "POST" && revoke) {
      const target = devices.get(decodeURIComponent(revoke));
      if (!target || target.user !== me.user) return deny("not_found", undefined, 404);
      target.revokedAt ??= new Date(now()).toISOString();
      return reply(200, { revoked: target.id });
    }
    return deny("not_found", undefined, 404);
  }

  const server = Bun.serve({ port: opts.port ?? 0, hostname: "127.0.0.1", fetch: handle });
  return {
    url: `http://127.0.0.1:${server.port}`,
    approve(code, user = DEFAULT_USER) {
      const entry = [...pending.values()].find((p) => p.userCode === code);
      if (!entry) throw new Error(`No pending sign-in with code ${code}`);
      entry.approvedBy = user;
    },
    devices: () => [...devices.values()],
    stop: () => void server.stop(true),
  };
}

if (import.meta.main) {
  const s = startDeviceServer({ port: DEVICE_AUTH.fakeServerPort, autoApprove: DEFAULT_USER });
  console.log(`Fake Sikrets device server on ${s.url}; sign-ins are approved as ${DEFAULT_USER}.`);
}
