import { createHash, generateKeyPairSync, randomBytes, sign as signWith } from "node:crypto";
import type { Hono } from "hono";
import { PROTOCOL } from "../constants.ts";

// A minimal device for server tests: a software P-256 key that signs proofs the way the CLI does
// (packages/cli/src/core/proof.ts), talking to the app in-process. Each call can bend the proof
// to test a rejection.

export interface ProofOverrides {
  method?: string;
  url?: string;
  body?: string;
  now?: number;
  nonce?: string;
  kid?: string | null;
  jwk?: JsonWebKey;
  proof?: string | null;
}

export interface Reply {
  status: number;
  body: any;
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

export function testDevice(app: Hono<any>, origin = "http://sikrets.test", opts: { now?: () => number; signedOrigin?: string } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { crv, kty, x, y } = publicKey.export({ format: "jwk" });
  const jwk: JsonWebKey = { crv, kty, x, y };
  const now = opts.now ?? Date.now;
  let deviceId: string | undefined;

  const sign = (data: string) => signWith("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" });

  async function proofFor(method: string, url: string, body: string, o: ProofOverrides) {
    // kid: null forces the registering form (jwk); a string names another device.
    const who = o.jwk ? { jwk: o.jwk } : o.kid === null ? { jwk } : o.kid ? { kid: o.kid } : deviceId ? { kid: deviceId } : { jwk };
    const header = { typ: PROTOCOL.proofType, alg: PROTOCOL.alg, ...who };
    const u = new URL(o.url ?? url);
    const claims = { htm: (o.method ?? method).toUpperCase(), htu: `${u.origin}${u.pathname}${u.search}`, iat: Math.floor((o.now ?? now()) / 1000), jti: o.nonce ?? randomBytes(16).toString("base64url"), bh: createHash("sha256").update(o.body ?? body).digest("base64url") };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    return `${input}.${b64url(sign(input))}`;
  }

  async function call(method: string, route: string, payload?: unknown, o: ProofOverrides = {}, headers: Record<string, string> = {}): Promise<Reply> {
    const url = `${origin}${route}`;
    const body = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
    // Behind a proxy the client signs the public URL, not the one the server sees.
    const proof = o.proof !== undefined ? o.proof : await proofFor(method, `${opts.signedOrigin ?? origin}${route}`, body, o);
    const res = await app.fetch(new Request(url, { method, body: body || undefined, headers: { ...(proof ? { [PROTOCOL.proofHeader]: proof } : {}), ...headers } }));
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  }

  return {
    jwk,
    get id() {
      return deviceId;
    },
    call,
    /** Starts a sign-in with this key; returns the request id and user code. */
    async start(name = "test-device") {
      const r = await call("POST", PROTOCOL.paths.authorize, { name, kind: "software", hardwareBound: false, publicKey: jwk }, { kid: null });
      return r.body as { requestId: string; userCode: string; verificationUri: string };
    },
    async collect(requestId: string) {
      const r = await call("POST", PROTOCOL.paths.token, { requestId }, { kid: null });
      if (r.status === 200) deviceId = r.body.deviceId;
      return r;
    },
    /** Signs in on an auto-approving server. */
    async signIn(name?: string) {
      const { requestId } = await this.start(name);
      const r = await this.collect(requestId);
      if (r.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(r.body)}`);
      return r.body as { deviceId: string; user: string; certificate: string };
    },
  };
}

export type TestDevice = ReturnType<typeof testDevice>;

/** A placeholder envelope: well-formed, but sealed under no key anyone holds. */
export const envelope = (bytes = 48) => `sk1:${randomBytes(bytes).toString("base64")}`;
