import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MODEL, OPENCODE, PROXY, SERVER } from "./constants.ts";
import { autoApprove, FullAccess } from "./full-access.ts";
import { proxy } from "./proxy.ts";
import { McpSwitches, sync } from "./mcp-switch.ts";
import type { Owner, Pool } from "./pool.ts";
import { Expiring } from "./store.ts";

// The gateway in front of opencode: the chat page, the access code, rate limits, the attestation
// document, and a filtered proxy for opencode's own API (src/proxy.ts), so the stock opencode
// clients work too. Each owner gets their own sandboxed instance (src/pool.ts), on loopback only.
//
// Two ways in, both checked against the access code:
// - browsers log in once and get a signed cookie;
// - opencode's TUI and desktop app send it as a basic-auth password (OPENCODE_PASSWORD).
// Each cookie is its own owner, with its own instance; basic-auth clients share one. Logging out
// revokes that cookie on the server (kept until it would have expired anyway).

export interface Options {
  accessCode?: string;
  /** Read the access code from this file instead, re-read when it changes: rotating the code
   * then signs everyone out without restarting the gateway (and every chat with it). */
  accessCodeFile?: string;
  /** Where to keep logins that logged out, until their cookies expire. */
  revokedFile?: string;
  /** Status the enclave writes for /healthz: { modelKey, tls }. */
  healthFile?: string;
  attestationFile?: string;
  /** Where to keep who turned on full access (src/full-access.ts). */
  fullAccessFile?: string;
  /** Where to keep each login's MCP switches (src/mcp-switch.ts). */
  mcpFile?: string;
}

const UI = path.join(import.meta.dir, "..", SERVER.uiDir);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'",
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...headers } });

/** Sliding one-minute (or longer) windows per key. */
function window(ms: number, max: number) {
  const hits = new Map<string, number[]>();
  return (key: string, count = true) => {
    const now = Date.now();
    const h = (hits.get(key) ?? []).filter((t) => now - t < ms);
    if (h.length >= max) return false;
    if (count) h.push(now);
    hits.set(key, h);
    return true;
  };
}

/** A set access code must say something: an empty one would open the gateway to everyone. */
function checked(code: string | undefined, from: string) {
  if (code !== undefined && !code.trim()) throw new Error(`The access code (${from}) is empty; refusing to start an open gateway. Unset it to run locally without one.`);
  return code?.trim();
}

/** The access code and the cookie key derived from it, from the option or the file. */
function accessCode(opts: Options) {
  const derive = (code: string | undefined) => ({ code, key: code ? createHmac("sha256", "sikrets-agent").update(code).digest() : undefined });
  if (!opts.accessCodeFile) {
    const fixed = derive(checked(opts.accessCode, "ACCESS_CODE"));
    return () => fixed;
  }
  const file = opts.accessCodeFile;
  let seen = { mtime: -1, value: derive(checked(readFileSync(file, "utf8"), file)) };
  return () => {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime !== seen.mtime) seen = { mtime, value: derive(checked(readFileSync(file, "utf8"), file)) };
    } catch {
      // Unreadable or emptied mid-rotation: keep the last good code, never fall open.
    }
    return seen.value;
  };
}

export function createGateway(pool: Pool, opts: Options = {}) {
  const current = accessCode(opts);
  const gated = Boolean(current().key);
  const api = proxy(pool, new McpSwitches(pool.capabilities.mcp, opts.mcpFile));
  const access = new FullAccess(opts.fullAccessFile);
  const revoked = new Expiring(opts.revokedFile);
  const approver = autoApprove(access);
  // Each instance, as it starts: its owner's MCP switches (a start that can't set them fails), and
  // Full access watching it.
  pool.use(async (owner, oc) => {
    await sync(oc, api.switches, owner);
    return approver.attach(owner, oc);
  });

  const sign = (payload: string, key = current().key!) => `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  const same = (a: string, b: string) => {
    const x = createHmac("sha256", "cmp").update(a).digest();
    const y = createHmac("sha256", "cmp").update(b).digest();
    return timingSafeEqual(x, y);
  };

  /** Who is asking and until when, or undefined if they haven't shown the access code. */
  function login(req: Request): { owner: Owner; until?: number; cookie?: boolean } | undefined {
    const { code, key } = current();
    if (!key) {
      // Gated at start and now without a code: the file went away. Closed, never open.
      return gated ? undefined : { owner: "local" };
    }
    const cookie = new RegExp(`(?:^|;\\s*)${SERVER.cookie}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];
    if (cookie) {
      const [exp, nonce] = cookie.split(".");
      const id = `web:${createHash("sha256").update(cookie).digest("hex").slice(0, 16)}`;
      if (exp && nonce && Number(exp) > Date.now() && same(sign(`${exp}.${nonce}`, key), cookie) && !revoked.has(id)) return { owner: id, until: Number(exp), cookie: true };
    }
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString();
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (same(password, code!)) return { owner: PROXY.basicOwner };
    }
    return undefined;
  }
  const owner = (req: Request) => login(req)?.owner;

  const failed = window(15 * 60_000, 8);
  const requests = window(60_000, SERVER.requestsPerMinute);
  const messages = window(60_000, SERVER.perMinute);
  let day = { date: "", count: 0 };
  const modelLimit = (client: string) => () => {
    if (!messages(client)) return "Too many messages; wait a minute.";
    const today = new Date().toISOString().slice(0, 10);
    if (day.date !== today) day = { date: today, count: 0 };
    if (++day.count > SERVER.perDay) return "The demo's daily limit is used up; try tomorrow.";
    return undefined;
  };

  async function fetch(req: Request, client: string): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return health();

    if (url.pathname === "/attestation" || url.pathname === "/api/attestation") {
      const file = Bun.file(opts.attestationFile ?? SERVER.attestationFile);
      return json((await file.exists()) ? await file.json() : { enclave: false });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      if (!failed(client, false)) return json({ error: "Too many attempts; try again in 15 minutes." }, 429);
      const { code: given } = (await req.json().catch(() => ({}))) as { code?: string };
      const { code } = current();
      if (!code || !given || !same(given.trim(), code)) {
        failed(client);
        return json({ error: "That code isn't right." }, 401);
      }
      const expires = Date.now() + SERVER.sessionDays * 86_400_000;
      const value = sign(`${expires}.${randomBytes(9).toString("base64url")}`);
      return json({ ok: true }, 200, { "set-cookie": `${SERVER.cookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SERVER.sessionDays * 86_400}` });
    }

    // Logout: this cookie stops working here and now (not only in this browser), its instance
    // stops, and its Full access goes with it.
    if (url.pathname === "/api/logout" && req.method === "POST") {
      const who = login(req);
      if (who?.cookie) {
        revoked.add(who.owner, who.until);
        access.set(who.owner, false);
        pool.stopOwner(who.owner);
      }
      return json({ ok: true }, 200, { "set-cookie": `${SERVER.cookie}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }

    if (url.pathname === "/api/me") {
      const who = owner(req);
      // `sandbox`: how each owner's instance is confined (src/sandbox.ts), so a deploy can be checked from outside.
      return json({ authed: Boolean(who), gated, model: MODEL.name, fullAccess: access.has(who), sandbox: pool.mode });
    }

    if (url.pathname === "/api/full-access" && req.method === "PUT") {
      const who = login(req);
      if (!who) return json({ error: "Enter the access code first." }, 401);
      const { on } = (await req.json().catch(() => ({}))) as { on?: unknown };
      if (typeof on !== "boolean") return json({ error: "Send { on: true | false }." }, 400);
      access.set(who.owner, on, who.until);
      const running = pool.running(who.owner);
      if (on && running) await approver.pending(running);
      return json({ fullAccess: on });
    }
    if (url.pathname.startsWith("/api/")) {
      // opencode's desktop app calls from its own page origin, so it needs CORS; no other origin gets it.
      const origin = req.headers.get("origin") ?? "";
      const cors: Record<string, string> = PROXY.corsOrigins.some((o) => origin.startsWith(o))
        ? { "access-control-allow-origin": origin, "access-control-allow-headers": req.headers.get("access-control-request-headers") ?? "authorization, content-type", "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE", "access-control-max-age": "600", vary: "Origin" }
        : {};
      if (req.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 404, headers: cors });
      const res = await forward(req, url, client);
      for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) res.headers.set(k, v);
      return res;
    }

    return req.method === "GET" ? page(url) : json({ error: "Not found" }, 404);
  }

  async function forward(req: Request, url: URL, client: string): Promise<Response> {
    if (!requests(client)) return json({ error: "Slow down." }, 429);
    const auth = req.headers.get("authorization");
    if (auth && !failed(client, false)) return json({ error: "Too many attempts; try again in 15 minutes." }, 429);
    const who = owner(req);
    if (!who) {
      if (auth) failed(client);
      return json({ error: "Enter the access code first." }, 401);
    }
    const res = await api.handle(req, who, modelLimit(client));
    // Method, path and status only: never query strings or bodies.
    if (SERVER.logRequests) console.log(`${req.method} ${url.pathname} ${res?.status ?? "404 (not allowed)"}`);
    return res ?? json({ error: "Not found" }, 404);
  }

  /** Up, and whether it has what it needs: the model key, and in the enclave, the key's and the
   * certificate's state (from bootstrap.py). 503 when one of those is broken, so the host's
   * heartbeat alarms; a gateway that doesn't answer at all is what the host restarts. */
  function health(): Response {
    const status: Record<string, unknown> = { modelKey: Boolean(Bun.env[OPENCODE.keyEnv] ?? Bun.env[MODEL.keyEnv]) ? "ok" : "missing" };
    if (opts.healthFile) {
      try {
        Object.assign(status, JSON.parse(readFileSync(opts.healthFile, "utf8")) as Record<string, unknown>);
      } catch {
        status.enclave = "no status yet";
      }
    }
    const ok = (!opts.healthFile || status.enclave === undefined) && status.modelKey === "ok" && !String(status.tls ?? "").startsWith("error");
    return json({ ok, ...status }, ok ? 200 : 503);
  }

  /** The chat page: static files, and index.html for client-side routes. */
  async function page(url: URL): Promise<Response> {
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = Bun.file(path.join(UI, rel));
    const asset = rel.startsWith("/assets/");
    if (rel === "/" || !(await file.exists())) {
      if (asset) return json({ error: "Not found" }, 404);
      file = Bun.file(path.join(UI, "index.html"));
    }
    return new Response(file, { headers: { ...SECURITY_HEADERS, "cache-control": asset ? "public, max-age=31536000, immutable" : "no-cache" } });
  }

  return { fetch, stop: () => pool.stop() };
}
