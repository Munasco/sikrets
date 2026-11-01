import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { MODEL, PROXY, SERVER } from "./constants.ts";
import type { Server } from "./opencode.ts";
import { Owners, proxy, type Owner } from "./proxy.ts";

// The gateway in front of opencode: the chat page, the access code, rate limits, the attestation
// document, and a filtered proxy for opencode's own API (src/proxy.ts), so the stock opencode
// clients work too. opencode listens on loopback only.
//
// Two ways in, both checked against the access code:
// - browsers log in once and get a signed cookie;
// - opencode's TUI and desktop app send it as a basic-auth password (OPENCODE_PASSWORD).
// Each cookie is its own owner of sessions; basic-auth clients share one.

export interface Options {
  accessCode?: string;
  attestationFile?: string;
  /** Where to keep the session-to-owner map across restarts. */
  ownersFile?: string;
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

export function createGateway(oc: Server, opts: Options = {}) {
  const code = opts.accessCode;
  const key = code ? createHmac("sha256", "sikrets-agent").update(code).digest() : undefined;
  const api = proxy(oc, new Owners(opts.ownersFile));

  const sign = (payload: string) => `${payload}.${createHmac("sha256", key!).update(payload).digest("base64url")}`;
  const same = (a: string, b: string) => {
    const x = createHmac("sha256", "cmp").update(a).digest();
    const y = createHmac("sha256", "cmp").update(b).digest();
    return timingSafeEqual(x, y);
  };

  /** Who is asking, or undefined if they haven't shown the access code. */
  function owner(req: Request): Owner | undefined {
    if (!key) return "local";
    const cookie = new RegExp(`(?:^|;\\s*)${SERVER.cookie}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1];
    if (cookie) {
      const [exp, nonce] = cookie.split(".");
      if (exp && nonce && Number(exp) > Date.now() && same(sign(`${exp}.${nonce}`), cookie)) return `web:${createHash("sha256").update(cookie).digest("hex").slice(0, 16)}`;
    }
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (basic) {
      const decoded = Buffer.from(basic, "base64").toString();
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (same(password, code!)) return PROXY.basicOwner;
    }
    return undefined;
  }

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
    if (url.pathname === "/healthz") return new Response("ok");

    if (url.pathname === "/attestation" || url.pathname === "/api/attestation") {
      const file = Bun.file(opts.attestationFile ?? SERVER.attestationFile);
      return json((await file.exists()) ? await file.json() : { enclave: false });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      if (!failed(client, false)) return json({ error: "Too many attempts; try again in 15 minutes." }, 429);
      const { code: given } = (await req.json().catch(() => ({}))) as { code?: string };
      if (!key || !given || !same(given.trim(), code!)) {
        failed(client);
        return json({ error: "That code isn't right." }, 401);
      }
      const expires = Date.now() + SERVER.sessionDays * 86_400_000;
      const value = sign(`${expires}.${randomBytes(9).toString("base64url")}`);
      return json({ ok: true }, 200, { "set-cookie": `${SERVER.cookie}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SERVER.sessionDays * 86_400}` });
    }

    if (url.pathname === "/api/me") return json({ authed: Boolean(owner(req)), gated: Boolean(key), model: MODEL.name });

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

  return { fetch, owners: api.owners };
}
