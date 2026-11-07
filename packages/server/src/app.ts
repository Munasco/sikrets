import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as signWith, type KeyObject } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ApprovalPolicy } from "./approval.ts";
import { isPublicP256, jwkThumbprint, ProofError, verifyProof, type ProofHeader } from "./proof.ts";
import type { AuditEvent, DataKeyClaim, DeviceRecord, Scope, SignIn, Store } from "./store.ts";
import { ACCOUNT, API_VERSION, AUDIT, PROTOCOL, SERVICE, VALUES } from "./constants.ts";

// The Sikrets server's HTTP API. It owns devices, sign-in and storage, and never sees a secret:
// values arrive as `sk1:` envelopes sealed on the client and leave the same way. Every request
// except sign-in's first two steps carries a proof signed by a registered device, and the account
// is always the device's own, never something the request names.

export interface AppOptions {
  store: Store;
  approval: ApprovalPolicy;
  /** The URL clients use, when it differs from what the server sees (a TLS-terminating proxy). */
  publicUrl?: string;
  maxValueBytes?: number;
  now?: () => number;
}

type Env = { Variables: { body: string; device: DeviceRecord } };

const P = PROTOCOL.paths;
const deny = (c: Context, error: string, reason?: string, status: 400 | 401 | 403 | 404 | 409 | 412 | 413 = 401) => c.json({ error, ...(reason ? { reason } : {}) }, status);
const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const randomId = (prefix: string) => `${prefix}${randomBytes(9).toString("base64url")}`;

function userCode() {
  const a = PROTOCOL.userCodeAlphabet;
  const text = [...randomBytes(PROTOCOL.userCodeChars)].map((b) => a[b % a.length]).join("");
  return `${text.slice(0, PROTOCOL.userCodeChars / 2)}-${text.slice(PROTOCOL.userCodeChars / 2)}`;
}

/** Why a value isn't a well-formed envelope, or undefined when it is one. Plaintext never gets past this. */
export function envelopeProblem(value: unknown, maxBytes: number): { reason: string; tooLarge?: boolean } | undefined {
  if (typeof value !== "string") return { reason: "value must be a string" };
  if (Buffer.byteLength(value) > maxBytes) return { reason: `value is over ${maxBytes} bytes`, tooLarge: true };
  if (!value.startsWith(VALUES.envelopePrefix)) return { reason: `only sealed ${VALUES.envelopePrefix} envelopes are stored; seal the value on the client` };
  const body = value.slice(VALUES.envelopePrefix.length);
  if (!VALUES.base64.test(body) || Buffer.from(body, "base64").length < VALUES.envelopeMinBytes) return { reason: "malformed envelope" };
  return undefined;
}

export function createApp(opts: AppOptions): Hono<Env> {
  const { store, approval } = opts;
  const now = opts.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const maxValueBytes = opts.maxValueBytes ?? VALUES.maxValueBytes;
  const maxBodyBytes = maxValueBytes + VALUES.bodyOverheadBytes;
  const app = new Hono<Env>();

  // The key that signs device certificates, created once and kept in the store.
  let certKey: Promise<KeyObject> | undefined;
  const certificateKey = () =>
    (certKey ??= store
      .ensureMeta("certificateKey", () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString())
      .then((pem) => createPrivateKey(pem)));

  const audit = (e: Omit<AuditEvent, "at">) => store.appendAudit({ at: iso(), ...e });

  /** The URL the client signed: the public URL's origin when one is configured. */
  const signedUrl = (c: Context) => {
    if (!opts.publicUrl) return c.req.url;
    const u = new URL(c.req.url);
    return `${opts.publicUrl.replace(/\/+$/, "")}${u.pathname}${u.search}`;
  };

  async function readBody(c: Context): Promise<string | Response> {
    if (Number(c.req.header("content-length") ?? 0) > maxBodyBytes) return deny(c, "too_large", `request body is over ${maxBodyBytes} bytes`, 413);
    const body = await c.req.text();
    if (Buffer.byteLength(body) > maxBodyBytes) return deny(c, "too_large", `request body is over ${maxBodyBytes} bytes`, 413);
    return body;
  }

  const input = (body: string): Record<string, unknown> | undefined => {
    if (!body) return {};
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  /** Verifies the proof. A kid must name a live device; a bare jwk is accepted only where `allowJwk`. */
  async function check(c: Context, body: string, allowJwk: boolean) {
    let device: DeviceRecord | undefined;
    const proof = await verifyProof(c.req.header(PROTOCOL.proofHeader), {
      method: c.req.method,
      url: signedUrl(c),
      body,
      now: now(),
      claimNonce: (jti, expiresAt, at) => store.claimNonce(jti, expiresAt, at),
      // A revoked key is refused under any device id, and can't sign in again (even with auto approval).
      async keyFor(header: ProofHeader) {
        if (header.kid) {
          device = await store.getDevice(String(header.kid));
          if (!device) throw new ProofError("unknown device");
          if (device.revokedAt || (await store.isKeyRevoked(jwkThumbprint(device.jwk)))) throw new ProofError("device revoked");
          return device.jwk;
        }
        if (allowJwk && isPublicP256(header.jwk)) {
          if (await store.isKeyRevoked(jwkThumbprint(header.jwk))) throw new ProofError(PROTOCOL.keyRevoked);
          return header.jwk;
        }
        throw new ProofError("no device key");
      },
    });
    return { ...proof, device };
  }

  /** Middleware for everything a registered device does: proof checked, device and body on the context. */
  const signedIn = async (c: Context<Env>, next: () => Promise<void>) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    try {
      const { device } = await check(c, body, false);
      if (!device) return deny(c, "invalid_proof", "no device key");
      // Only lastSeenAt, and only on an active device: never a whole-record write that could undo a revoke.
      const seen = iso();
      if (!(await store.touchDevice(device.id, seen))) return deny(c, "invalid_proof", "device revoked");
      c.set("device", { ...device, lastSeenAt: seen });
      c.set("body", body);
    } catch (error) {
      if (error instanceof ProofError) return deny(c, "invalid_proof", error.reason);
      throw error;
    }
    await next();
  };

  app.onError((error, c) => {
    console.error(`sikrets-server: ${c.req.method} ${new URL(c.req.url).pathname} failed: ${error instanceof Error ? error.name : "error"}`);
    return c.json({ error: "server_error" }, 500);
  });
  app.notFound((c) => deny(c, "not_found", undefined, 404));

  // ── Discovery ───────────────────────────────────────────────────────────
  app.get(P.info, async (c) => {
    const { crv, kty, x, y } = createPublicKey(await certificateKey()).export({ format: "jwk" });
    return c.json({ service: SERVICE, apiVersion: API_VERSION, approval: approval.mode, certificateKey: { crv, kty, x, y } });
  });

  // ── Sign-in (RFC 8628 device flow, proofs signed by the key being registered) ─
  app.post(P.authorize, async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    let header: ProofHeader;
    try {
      ({ header } = await check(c, body, true));
    } catch (error) {
      if (error instanceof ProofError) return deny(c, "invalid_proof", error.reason);
      throw error;
    }
    const req = input(body);
    if (!req || !header.jwk) return deny(c, "invalid_request", undefined, 400);
    if (!isPublicP256(req.publicKey) || jwkThumbprint(req.publicKey) !== jwkThumbprint(header.jwk)) return deny(c, "invalid_request", "the proof isn't signed by the key being registered", 400);
    const { crv, kty, x, y } = header.jwk;
    const signIn: SignIn = {
      requestId: randomId(PROTOCOL.requestIdPrefix),
      jwk: { crv, kty, x, y },
      jkt: jwkThumbprint(header.jwk),
      name: String(req.name ?? "device").slice(0, PROTOCOL.maxDeviceName),
      kind: req.kind === "secure-enclave" ? "secure-enclave" : "software",
      // The client's word for now; attestation will back it later.
      hardwareBound: req.hardwareBound === true,
      userCode: userCode(),
      expiresAt: now() + PROTOCOL.approvalTimeoutMs,
      status: "pending",
    };
    const auto = approval.onStart(signIn);
    if (auto) Object.assign(signIn, { status: "approved", approvedBy: auto });
    await store.createSignIn(signIn, now());
    const origin = opts.publicUrl?.replace(/\/+$/, "") ?? new URL(c.req.url).origin;
    return c.json({
      requestId: signIn.requestId,
      userCode: signIn.userCode,
      verificationUri: `${origin}${P.approve}?code=${signIn.userCode}`,
      interval: PROTOCOL.pollIntervalSeconds,
      expiresIn: PROTOCOL.approvalTimeoutMs / 1000,
    });
  });

  app.post(P.token, async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    let header: ProofHeader;
    try {
      ({ header } = await check(c, body, true));
    } catch (error) {
      if (error instanceof ProofError) return deny(c, "invalid_proof", error.reason);
      throw error;
    }
    const req = input(body);
    const signIn = req && typeof req.requestId === "string" ? await store.getSignIn(req.requestId) : undefined;
    if (!signIn || !header.jwk) return deny(c, "invalid_grant", undefined, 400);
    // Only the key that started the sign-in can collect it.
    if (jwkThumbprint(header.jwk) !== signIn.jkt) return deny(c, "invalid_grant", "a different key started this sign-in", 400);
    if (signIn.expiresAt < now() && (signIn.status === "pending" || signIn.status === "approved")) {
      await store.expireSignIn(signIn.requestId, now());
      return deny(c, "expired_token", undefined, 400);
    }
    switch (signIn.status) {
      case "pending":
        return deny(c, PROTOCOL.pending, undefined, 400);
      case "denied":
        return deny(c, "access_denied", undefined, 400);
      case "expired":
        return deny(c, "expired_token", undefined, 400);
      case "collected":
        return deny(c, "invalid_grant", "this sign-in was already collected", 400);
    }
    // Collected once: of two polls racing, only one gets a device.
    const approved = await store.collectSignIn(signIn.requestId, now());
    if (!approved?.approvedBy) return deny(c, "invalid_grant", "this sign-in was already collected", 400);

    const device: DeviceRecord = { id: randomId(PROTOCOL.deviceIdPrefix), user: approved.approvedBy, name: approved.name, kind: approved.kind, hardwareBound: approved.hardwareBound, registeredAt: iso(), jwk: approved.jwk };
    await store.createDevice(device);
    // The same key signing in again replaces its earlier registrations, so it isn't live under two ids.
    for (const old of await store.listDevices(device.user)) {
      if (old.id !== device.id && !old.revokedAt && jwkThumbprint(old.jwk) === signIn.jkt && (await store.revokeDevice(old.id, iso()))) {
        await audit({ user: device.user, deviceId: device.id, action: `device.replace ${old.id}`, outcome: "ok" });
      }
    }
    const key = await certificateKey();
    const input64 = `${b64url(JSON.stringify({ typ: PROTOCOL.certificateType, alg: PROTOCOL.alg }))}.${b64url(JSON.stringify({ sub: device.id, user: device.user, cnf: { jkt: signIn.jkt }, hw: device.hardwareBound, iat: Math.floor(now() / 1000) }))}`;
    const certificate = `${input64}.${b64url(signWith("sha256", Buffer.from(input64), { key, dsaEncoding: "ieee-p1363" }))}`;
    await audit({ user: device.user, deviceId: device.id, action: "device.register", outcome: "ok" });
    return c.json({ deviceId: device.id, user: device.user, certificate });
  });

  // The approval page. A browser sign-in replaces the GET; the POST stays for devices and operators.
  app.get(P.approve, (c) =>
    c.text(
      approval.mode === "auto"
        ? "This Sikrets server approves sign-ins automatically. Go back to your terminal.\n"
        : `Approve sign-in ${c.req.query("code") ?? ""} from a device that is already signed in, or ask the server's operator.\n`,
    ),
  );

  app.post(P.approve, async (c) => {
    const body = await readBody(c);
    if (body instanceof Response) return body;
    let device: DeviceRecord | undefined;
    if (c.req.header(PROTOCOL.proofHeader)) {
      try {
        ({ device } = await check(c, body, false));
      } catch (error) {
        if (error instanceof ProofError) return deny(c, "invalid_proof", error.reason);
        throw error;
      }
    }
    const req = input(body) ?? {};
    const requested = typeof req.user === "string" ? req.user : undefined;
    if (requested !== undefined && !ACCOUNT.test(requested)) return deny(c, "invalid_request", "invalid account", 400);
    const user = approval.approver(c.req.raw, { device: device?.user, requested });
    if (!user) return deny(c, "forbidden", "sign in on an approved device, or use the admin token", 403);
    const code = String(req.code ?? c.req.query("code") ?? "");
    const signIn = code ? await store.findSignInByCode(code) : undefined;
    if (!signIn || signIn.expiresAt < now()) return deny(c, "not_found", undefined, 404);
    // Decided once: approving again (as this account or another) or after a collect is refused.
    if (signIn.status !== "pending") return deny(c, "already_decided", `this sign-in is ${signIn.status}`, 409);
    if (await store.isKeyRevoked(signIn.jkt)) return deny(c, "forbidden", "that device key was revoked", 403);
    if (req.deny === true) {
      if (!(await store.denySignIn(signIn.requestId))) return deny(c, "already_decided", undefined, 409);
      await audit({ user, deviceId: device?.id, action: "device.deny", outcome: "ok" });
      return c.json({ approved: false });
    }
    if (!(await store.approveSignIn(signIn.requestId, user, now()))) return deny(c, "already_decided", undefined, 409);
    await audit({ user, deviceId: device?.id, action: "device.approve", outcome: "ok" });
    return c.json({ approved: true });
  });

  // ── Devices ─────────────────────────────────────────────────────────────
  const visible = ({ jwk: _jwk, user: _user, ...d }: DeviceRecord) => d;

  app.get(P.me, signedIn, (c) => c.json({ user: c.var.device.user, deviceId: c.var.device.id }));
  app.get(P.devices, signedIn, async (c) => c.json({ devices: (await store.listDevices(c.var.device.user)).map(visible) }));
  app.post(P.revoke, signedIn, async (c) => {
    const me = c.var.device;
    const target = await store.getDevice(c.req.param("id")!);
    if (!target || target.user !== me.user) return deny(c, "not_found", undefined, 404);
    // The key first (refused for good, under any id, and from signing in again), then every device using it.
    const jkt = jwkThumbprint(target.jwk);
    await store.revokeKey(jkt, iso());
    for (const d of await store.listDevices(me.user)) {
      if (jwkThumbprint(d.jwk) === jkt && (await store.revokeDevice(d.id, iso()))) await audit({ user: me.user, deviceId: me.id, action: `device.revoke ${d.id}`, outcome: "ok" });
    }
    return c.json({ revoked: target.id });
  });

  app.get(P.audit, signedIn, async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || AUDIT.defaultLimit, 1), AUDIT.maxLimit);
    return c.json({ events: await store.listAudit(c.var.device.user, limit) });
  });

  // ── Sealed values ───────────────────────────────────────────────────────
  /** The scope from the path, always under the calling device's own account. */
  const scopeOf = (c: Context<Env>): Scope | undefined => {
    const { project, environment } = c.req.param() as Record<string, string>;
    if (!VALUES.project.test(project ?? "") || !VALUES.environment.test(environment ?? "")) return undefined;
    return { account: c.var.device.user, project: project!, environment: environment! };
  };
  const nameOf = (c: Context<Env>) => {
    const name = c.req.param("name") ?? "";
    return VALUES.name.test(name) ? name : undefined;
  };
  const record = (c: Context<Env>, scope: Scope, action: string, outcome: AuditEvent["outcome"], name?: string) =>
    audit({ user: scope.account, deviceId: c.var.device.id, action, project: scope.project, environment: scope.environment, ...(name ? { name } : {}), outcome });

  // One data key per project, whatever the environment: the first write claims the project for its
  // key's fingerprint (a conditional create), and every later write must carry the same one. Two
  // devices that each made a key can't both seal values here; the one that lost is told to restore.
  const projectOf = (c: Context<Env>) => {
    const project = c.req.param("project") ?? "";
    return VALUES.project.test(project) ? project : undefined;
  };
  const fingerprintOf = (req: Record<string, unknown> | undefined, field: string) => {
    const fp = req?.[field];
    return typeof fp === "string" && VALUES.fingerprint.test(fp) ? fp : undefined;
  };
  const mismatch = `this project is sealed with a different data key; restore that key on this device (sikrets recovery restore)`;
  /** The claim that holds after this device asks for `fingerprint`. */
  const claim = (c: Context<Env>, project: string, fingerprint: string): Promise<DataKeyClaim> =>
    store.claimDataKey(c.var.device.user, project, { fingerprint, claimedAt: iso(), claimedBy: c.var.device.id });

  app.get(P.dataKey, signedIn, async (c) => {
    const project = projectOf(c);
    if (!project) return deny(c, "invalid_request", "invalid project", 400);
    const held = await store.getDataKeyClaim(c.var.device.user, project);
    if (!held) return deny(c, "not_found", undefined, 404);
    return c.json({ fingerprint: held.fingerprint, claimedAt: held.claimedAt });
  });

  app.put(P.dataKey, signedIn, async (c) => {
    const project = projectOf(c);
    if (!project) return deny(c, "invalid_request", "invalid project", 400);
    const fingerprint = fingerprintOf(input(c.var.body), "fingerprint");
    if (!fingerprint) return deny(c, "invalid_request", "fingerprint must be the data key's fingerprint (hex)", 400);
    const held = await claim(c, project, fingerprint);
    const ok = held.fingerprint === fingerprint;
    await audit({ user: c.var.device.user, deviceId: c.var.device.id, action: "datakey.claim", project, outcome: ok ? "ok" : "denied" });
    if (!ok) return deny(c, PROTOCOL.dataKeyMismatch, mismatch, 409);
    return c.json({ fingerprint: held.fingerprint, claimedAt: held.claimedAt });
  });

  app.get(P.values, signedIn, async (c) => {
    const scope = scopeOf(c);
    if (!scope) return deny(c, "invalid_request", "invalid project or environment", 400);
    const values = await store.listValues(scope);
    await record(c, scope, "values.list", "ok");
    return c.json({ values });
  });

  app.get(P.value, signedIn, async (c) => {
    const scope = scopeOf(c);
    const name = nameOf(c);
    if (!scope || !name) return deny(c, "invalid_request", "invalid project, environment or name", 400);
    const value = await store.getValue(scope, name);
    await record(c, scope, "value.get", value ? "ok" : "missing", name);
    if (!value) return deny(c, "not_found", undefined, 404);
    return c.json(value);
  });

  app.put(P.value, signedIn, async (c) => {
    const scope = scopeOf(c);
    const name = nameOf(c);
    if (!scope || !name) return deny(c, "invalid_request", "invalid project, environment or name", 400);
    const req = input(c.var.body);
    const problem = envelopeProblem(req?.value, maxValueBytes);
    if (problem) {
      await record(c, scope, "value.put", "denied", name);
      return deny(c, problem.tooLarge ? "too_large" : "invalid_value", problem.reason, problem.tooLarge ? 413 : 400);
    }
    const fingerprint = fingerprintOf(req, "dataKey");
    if (!fingerprint) {
      await record(c, scope, "value.put", "denied", name);
      return deny(c, "invalid_request", "dataKey must be the fingerprint of the data key the value is sealed with", 400);
    }
    if ((await claim(c, scope.project, fingerprint)).fingerprint !== fingerprint) {
      await record(c, scope, "value.put", "denied", name);
      return deny(c, PROTOCOL.dataKeyMismatch, mismatch, 409);
    }
    const stored = { name, value: req!.value as string, updatedAt: iso(), updatedBy: c.var.device.id };
    // ifAbsent: create only (sikrets migrate), so a value written meanwhile isn't overwritten.
    if (req!.ifAbsent === true) {
      if (!(await store.createValue(scope, stored))) {
        await record(c, scope, "value.put", "denied", name);
        return deny(c, "exists", "a value with this name is already stored", 412);
      }
    } else await store.putValue(scope, stored);
    await record(c, scope, "value.put", "ok", name);
    return c.json({ name, updatedAt: stored.updatedAt });
  });

  app.delete(P.value, signedIn, async (c) => {
    const scope = scopeOf(c);
    const name = nameOf(c);
    if (!scope || !name) return deny(c, "invalid_request", "invalid project, environment or name", 400);
    const deleted = await store.deleteValue(scope, name);
    await record(c, scope, "value.delete", deleted ? "ok" : "missing", name);
    return c.json({ deleted });
  });

  return app;
}
