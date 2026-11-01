import { createHash } from "node:crypto";
import { agentNameFor, clientStore, hashToken, matches, newToken, type Client, type ClientStore, type Registration } from "../core/mcp-clients.ts";
import { askOnMac } from "../core/logins/approve.ts";
import { createServer, type ServerOptions } from "./mcp.ts";
import { MCP_HTTP } from "../constants.ts";

// `sikrets mcp --http`: the MCP server over Streamable HTTP (MCP 2025-06-18 and later), for apps
// that connect to a URL instead of starting a process.
//
// Who can call it: only a client with a current bearer token. Each token belongs to one named
// client (`sikrets mcp clients add`), or, with --oauth, to an app the owner approved on this Mac
// through OAuth 2.1 (PKCE, dynamic client registration). That client's name is its agent identity:
// login approvals and grants apply to it exactly as they do over stdio, and it can't claim another
// name. What it can do: the same tools as stdio, which act and never return a secret value.
//
// Guard rails: listens on 127.0.0.1 unless told otherwise; rejects Host and Origin headers that
// aren't this machine or the --public-url (DNS rebinding); rate-limits each client, bad tokens and
// OAuth prompts; caps request size. It never opens a tunnel; see docs/mcp.md for that.

export interface HttpOptions extends Omit<ServerOptions, "agent"> {
  host: string;
  port: number;
  /** The https URL a tunnel forwards to this server, e.g. https://name.trycloudflare.com. */
  publicUrl?: string;
  /** Serve OAuth 2.1 so apps that only speak OAuth (ChatGPT, Claude.ai) can connect. */
  oauth?: boolean;
  store?: ClientStore;
  /** Asks the owner whether an OAuth app may connect. Default: a dialog and Touch ID on this Mac. */
  approveConnect?: (request: { app: string; agent: string; redirectHost: string }) => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
}

const LOOPBACK = new Set<string>(MCP_HTTP.loopbackHosts);
const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase());

/** Token bucket per key. */
function limiter({ perMinute, burst }: { perMinute: number; burst: number }) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (key: string, now: number) => {
    if (buckets.size > 10_000) buckets.clear();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perMinute) * 60);
    b.tokens -= 1;
    return 0;
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** https anywhere, or http on this machine (for apps that catch the redirect locally). No fragments. */
function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname));
  } catch {
    return false;
  }
}

export const baseUrl = (opts: Pick<HttpOptions, "host" | "port" | "publicUrl">) => {
  if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? MCP_HTTP.defaultHost : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return `http://${host}:${opts.port}`;
};

export function createHttpHandler(opts: HttpOptions) {
  const store = opts.store ?? clientStore();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.error(line));
  const base = baseUrl(opts);
  const resource = `${base}${MCP_HTTP.path}`;
  const resourceMetadata = `${base}/.well-known/oauth-protected-resource${MCP_HTTP.path}`;
  const publicHost = opts.publicUrl ? new URL(opts.publicUrl).hostname.toLowerCase() : undefined;
  const publicOrigin = opts.publicUrl ? new URL(opts.publicUrl).origin : undefined;
  const approveConnect =
    opts.approveConnect ??
    (async ({ app, agent, redirectHost }) =>
      Boolean(
        await askOnMac(
          `"${app}" wants to connect to Sikrets as "${agent}" (it returns to ${redirectHost}).\n\n` +
            "It can list secret names, run allowed programs with your secrets, and ask to sign in to sites. It never sees a value.",
          ["Deny", "Allow"],
          `let ${app} connect to Sikrets`,
        ),
      ));

  const perClient = limiter(MCP_HTTP.rateLimit);
  const badAuth = limiter(MCP_HTTP.authFailures);
  const prompts = limiter(MCP_HTTP.oauthPrompts);
  let prompting = false;
  const servers = new Map<string, ReturnType<typeof createServer>>();
  const touched = new Map<string, number>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; expiresAt: number }>();

  function hostAllowed(req: Request) {
    const host = req.headers.get("host");
    if (!host) return false;
    const name = new URL(`http://${host}`).hostname.toLowerCase();
    return isLoopback(name) || name === publicHost || (name === opts.host.toLowerCase() && !["0.0.0.0", "::"].includes(opts.host));
  }

  function originAllowed(req: Request) {
    const origin = req.headers.get("origin");
    if (!origin) return true; // servers and CLIs send none; browsers always do
    try {
      const u = new URL(origin);
      return isLoopback(u.hostname) || u.origin === publicOrigin;
    } catch {
      return false;
    }
  }

  const unauthorized = (presented: boolean) =>
    json({ error: presented ? "invalid_token" : "unauthorized", error_description: presented ? "Unknown, expired or revoked token" : "Send Authorization: Bearer <token>" }, 401, {
      "www-authenticate": `Bearer realm="sikrets"${opts.oauth ? `, resource_metadata="${resourceMetadata}"` : ""}${presented ? ', error="invalid_token"' : ""}`,
    });

  // ── OAuth 2.1 ──────────────────────────────────────────────────────────
  const protectedResource = () =>
    json({ resource, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: MCP_HTTP.oauth.scopes, resource_name: "Sikrets" });

  const authorizationServer = () =>
    json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: MCP_HTTP.oauth.scopes,
    });

  async function register(req: Request) {
    const wait = prompts(`register`, now());
    if (wait) return oauthError("temporarily_unavailable", "Too many sign-ups; try again shortly", 429);
    const body = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "Expected a JSON body");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every(validRedirect)) return oauthError("invalid_redirect_uri", "redirect_uris must be https (or http on localhost)");
    const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 64) : "OAuth app";
    const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", `Unsupported token_endpoint_auth_method ${method}`);
    const clientId = newToken("sik_client_").reveal();
    const secret = method === "none" ? undefined : newToken(MCP_HTTP.tokenPrefix.clientSecret);
    const reg: Registration = { clientId, clientName, redirectUris: uris as string[], createdAt: new Date(now()).toISOString(), ...(secret ? { secretHash: hashToken(secret.reveal()) } : {}) };
    await store.update((r) => {
      // Keep the newest registrations; never drop one an approved client still uses.
      const used = new Set(r.clients.map((c) => c.clientId));
      const spare = r.registrations.filter((g) => !used.has(g.clientId));
      if (r.registrations.length >= MCP_HTTP.oauth.maxRegistrations && spare.length) r.registrations = r.registrations.filter((g) => g !== spare[0]);
      r.registrations.push(reg);
    });
    log(`sikrets mcp: registered OAuth app "${clientName}"`);
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(now() / 1000),
        client_name: clientName,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: method,
        ...(secret ? { client_secret: secret.reveal(), client_secret_expires_at: 0 } : {}),
      },
      201,
    );
  }

  async function authorize(url: URL) {
    const q = url.searchParams;
    const reg = (await store.load()).registrations.find((g) => g.clientId === q.get("client_id"));
    const redirectUri = q.get("redirect_uri") ?? (reg?.redirectUris.length === 1 ? reg.redirectUris[0] : undefined);
    // Without a known client and redirect there is nobody safe to redirect to.
    if (!reg || !redirectUri || !reg.redirectUris.includes(redirectUri)) return new Response("Unknown client or redirect_uri", { status: 400 });
    const back = (params: Record<string, string>) => {
      const to = new URL(redirectUri);
      for (const [k, v] of Object.entries({ ...params, ...(q.get("state") ? { state: q.get("state")! } : {}), iss: base })) to.searchParams.set(k, v);
      return Response.redirect(to.toString(), 302);
    };
    if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    const target = q.get("resource");
    if (target && target.replace(/\/+$/, "") !== resource) return back({ error: "invalid_target" });
    if (prompting || prompts("authorize", now())) return back({ error: "temporarily_unavailable", error_description: "Another approval is pending" });

    const agent = agentNameFor(reg.clientName, reg.clientId);
    prompting = true;
    const allowed = await approveConnect({ app: reg.clientName, agent, redirectHost: new URL(redirectUri).host })
      .catch(() => false)
      .finally(() => (prompting = false));
    log(`sikrets mcp: ${allowed ? "approved" : "denied"} OAuth app "${reg.clientName}" as ${agent}`);
    if (!allowed) return back({ error: "access_denied" });
    const code = newToken(MCP_HTTP.tokenPrefix.code).reveal();
    codes.set(hashToken(code), { clientId: reg.clientId, redirectUri, challenge, expiresAt: now() + MCP_HTTP.oauth.codeTtlSeconds * 1000 });
    return back({ code });
  }

  async function issue(reg: Registration, existing?: Client) {
    const access = newToken(MCP_HTTP.tokenPrefix.access);
    const refresh = newToken(MCP_HTTP.tokenPrefix.refresh);
    const t = now();
    await store.update((r) => {
      let c = r.clients.find((x) => x.clientId === reg.clientId) ?? existing;
      if (!c || !r.clients.includes(c)) {
        c = { name: agentNameFor(reg.clientName, reg.clientId), kind: "oauth", createdAt: new Date(t).toISOString(), clientId: reg.clientId };
        r.clients = r.clients.filter((x) => x.name !== c!.name);
        r.clients.push(c);
      }
      c.accessHash = hashToken(access.reveal());
      c.accessExpiresAt = t + MCP_HTTP.oauth.accessTtlSeconds * 1000;
      c.refreshHash = hashToken(refresh.reveal());
      c.refreshExpiresAt = t + MCP_HTTP.oauth.refreshTtlSeconds * 1000;
    });
    return json({ access_token: access.reveal(), token_type: "Bearer", expires_in: MCP_HTTP.oauth.accessTtlSeconds, refresh_token: refresh.reveal(), scope: MCP_HTTP.oauth.scopes.join(" ") });
  }

  async function token(req: Request, ip: string) {
    const form = new URLSearchParams(await req.text());
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = req.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    if (basic) {
      const [id, sec] = Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
      clientId = id ?? clientId;
      secret = sec ?? secret;
    }
    const fail = (error: string, description: string, status = 400) => {
      if (badAuth(ip, now())) return oauthError("slow_down", "Too many failed attempts", 429);
      return oauthError(error, description, status);
    };
    const reg = (await store.load()).registrations.find((g) => g.clientId === clientId);
    if (!reg) return fail("invalid_client", "Unknown client", 401);
    if (reg.secretHash && !matches(secret ?? "", reg.secretHash)) return fail("invalid_client", "Bad client secret", 401);

    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const key = hashToken(form.get("code") ?? "");
      const code = codes.get(key);
      codes.delete(key); // single use, even when the rest of the request is wrong
      if (!code || code.clientId !== reg.clientId || code.expiresAt < now()) return fail("invalid_grant", "Unknown or expired code");
      if (form.get("redirect_uri") && form.get("redirect_uri") !== code.redirectUri) return fail("invalid_grant", "redirect_uri doesn't match");
      if (s256(form.get("code_verifier") ?? "") !== code.challenge) return fail("invalid_grant", "PKCE verification failed");
      return issue(reg);
    }
    if (grant === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const client = (await store.list()).find((c) => c.clientId === reg.clientId && matches(presented, c.refreshHash) && (c.refreshExpiresAt ?? 0) > now());
      if (!client) return fail("invalid_grant", "Unknown, expired or revoked refresh token");
      return issue(reg, client);
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  // ── MCP ────────────────────────────────────────────────────────────────
  async function mcp(req: Request, ip: string) {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const presented = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const client = presented ? await store.authenticate(presented, now()) : undefined;
    if (!client) {
      const wait = badAuth(ip, now());
      if (wait) return json({ error: "rate_limited" }, 429, { "retry-after": String(wait) });
      return unauthorized(Boolean(presented));
    }
    const wait = perClient(client.name, now());
    if (wait) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `Rate limited; retry in ${wait}s` } }, 429, { "retry-after": String(wait) });
    if ((touched.get(client.name) ?? 0) < now() - 60_000) {
      touched.set(client.name, now());
      void store.touch(client.name).catch(() => undefined);
    }

    if (Number(req.headers.get("content-length") ?? 0) > MCP_HTTP.maxBodyBytes) return json({ error: "too_large" }, 413);
    const raw = await req.text();
    if (raw.length > MCP_HTTP.maxBodyBytes) return json({ error: "too_large" }, 413);
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(msg) || !msg || typeof msg !== "object") return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC message per request" } }, 400);
    const m = msg as { method?: unknown; id?: unknown; params?: { name?: unknown } };
    // Notifications and responses get 202 and no body.
    if (typeof m.method !== "string" || m.id === undefined) return new Response(null, { status: 202 });

    // The token decides who this is, not the name the app reports.
    let server = servers.get(client.name);
    if (!server) servers.set(client.name, (server = createServer({ ...opts, agent: client.name })));
    log(`sikrets mcp: ${client.name} ${m.method}${m.method === "tools/call" && typeof m.params?.name === "string" ? ` ${m.params.name}` : ""}`);
    const reply = server.handle(msg as Parameters<typeof server.handle>[0]);

    // A tool call can take minutes (a test run, an approval prompt): stream it as SSE with
    // keep-alive comments so tunnels don't time out. Everything else is a plain JSON answer.
    if (m.method === "tools/call" && req.headers.get("accept")?.includes("text/event-stream")) {
      const enc = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(enc.encode(": keep-alive\n\n")), MCP_HTTP.keepAliveMs);
          void reply.then((r) => {
            clearInterval(timer);
            controller.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(r)}\n\n`));
            controller.close();
          });
        },
        cancel: () => clearInterval(timer),
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return json(await reply);
  }

  async function fetch(req: Request, ip = "unknown"): Promise<Response> {
    if (!hostAllowed(req)) return json({ error: "Host not allowed" }, 403);
    if (!originAllowed(req)) return json({ error: "Origin not allowed" }, 403);
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p === MCP_HTTP.path) return mcp(req, ip);
    if (opts.oauth) {
      if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === `/.well-known/oauth-protected-resource${MCP_HTTP.path}`)) return protectedResource();
      if (req.method === "GET" && p === "/.well-known/oauth-authorization-server") return authorizationServer();
      if (req.method === "POST" && p === "/register") return register(req);
      if (req.method === "GET" && p === "/authorize") return authorize(url);
      if (req.method === "POST" && p === "/token") return token(req, ip);
    }
    return json({ error: "not_found" }, 404);
  }

  return { fetch, resource };
}

export function serveHttp(opts: HttpOptions) {
  let handler: ReturnType<typeof createHttpHandler> | undefined;
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    maxRequestBodySize: MCP_HTTP.maxBodyBytes,
    fetch(req, srv) {
      srv.timeout(req, 0); // tool calls and approval prompts can outlast the idle timeout
      return handler!.fetch(req, srv.requestIP(req)?.address ?? "unknown");
    },
  });
  // Built after listening so port 0 (any free port) still gives the right URLs.
  handler = createHttpHandler({ ...opts, port: server.port ?? opts.port });
  return { server, url: handler.resource, stop: () => server.stop(true) };
}
