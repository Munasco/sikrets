import net from "node:net";
import type { SessionCerts } from "./certs.ts";
import { AUTH_HEADERS, service, type Service } from "./services.ts";
import type { Secret } from "../secret.ts";
import { PROXY } from "../../constants.ts";

// The credential proxy. An agent points HTTPS_PROXY at it and authenticates with its session
// token. For hosts of services in the session's bundle, the proxy terminates TLS with the session
// CA, checks the session and its rules, replaces whatever credentials the agent sent with the real
// ones, and forwards the request. Every other host is tunnelled untouched (the proxy never sees
// that traffic), or refused when the session is limited to its services.
//
// Two listeners: a plain TCP one that speaks the proxy protocol (CONNECT), and an internal TLS
// server that CONNECTs to bundle hosts are piped into. The internal server learns which session a
// request belongs to from the connection's source port, recorded when the CONNECT was accepted.

export interface Rule {
  service: string;
  /** HTTP methods allowed; all when omitted. */
  methods?: string[];
}

/** A session is open until it expires, is revoked, or the proxy stops. Endings are final. */
export type SessionState = "open" | "expired" | "revoked" | "stopped";

export interface Session {
  readonly token: string;
  readonly bundle: string;
  readonly rules: ReadonlyMap<string, Rule>;
  /** Wall-clock deadline (ms since epoch). */
  readonly expiresAt: number;
  readonly state: SessionState;
}

export interface RequestLog {
  at: string;
  session: string;
  service: string | null;
  host: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Why the proxy refused, when it did. */
  denied?: string;
}

export interface ProxyOptions {
  certs: SessionCerts;
  /** Real tokens by service id. */
  tokens: ReadonlyMap<string, Secret>;
  onlyServices?: boolean;
  log?: (entry: RequestLog) => void;
  /** Tests: where requests for a bundle host really go (default https://<host>). */
  upstream?: (host: string) => string;
}

const HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host"];

// The wall clock decides, not only the timer: a timer can fire late (the Mac slept), the clock can't.
const alive = (s: Session | undefined): s is Session => !!s && s.state === "open" && Date.now() < s.expiresAt;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return PROXY.sessionPrefix + Buffer.from(bytes).toString("base64url");
}

function proxyUser(head: string): string | undefined {
  const value = /^proxy-authorization:\s*basic\s+(\S+)/im.exec(head)?.[1];
  if (!value) return undefined;
  // Node only sends proxy credentials when there's a password, so sessions use sikrets:<token>.
  const [user, pass] = Buffer.from(value, "base64").toString("utf8").split(":");
  return user === "sikrets" ? pass : user || pass;
}

interface Live extends Session {
  state: SessionState;
  timer?: ReturnType<typeof setTimeout>;
  onEnd?: (state: Exclude<SessionState, "open">) => void;
}

export async function startProxy(opts: ProxyOptions) {
  const sessions = new Map<string, Live>();
  const sockets = new Map<string, Set<net.Socket>>();
  const byPort = new Map<number, Session>();
  const hostToService = new Map<string, Service>();
  for (const id of opts.tokens.keys()) for (const host of Object.keys(service(id).hosts)) hostToService.set(host, service(id));
  const upstream = opts.upstream ?? ((host: string) => `https://${host}`);
  const log = opts.log ?? (() => {});

  const deny = (entry: Omit<RequestLog, "at" | "status" | "ms">, status: number, started: number) => {
    log({ at: new Date().toISOString(), status, ms: performance.now() - started, ...entry });
    return Response.json({ error: entry.denied, by: "sikrets proxy" }, { status, headers: { "x-sikrets-proxy": "denied" } });
  };

  const inner = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: Object.entries(opts.certs.hosts).map(([serverName, c]) => ({ serverName, cert: c.cert, key: c.key })),
    async fetch(req, server) {
      const started = performance.now();
      const url = new URL(req.url);
      const host = (req.headers.get("host") ?? url.hostname).replace(/:\d+$/, "");
      const session = byPort.get(server.requestIP(req)?.port ?? -1);
      const svc = hostToService.get(host);
      const base = { session: session?.token.slice(0, 10) ?? "none", service: svc?.id ?? null, host, method: req.method, path: url.pathname };
      if (!alive(session)) return deny({ ...base, denied: "session expired or revoked" }, 407, started);
      const rule = svc && session.rules.get(svc.id);
      if (!svc || !rule) return deny({ ...base, denied: `${host} isn't in this session's bundle` }, 403, started);
      if (rule.methods && !rule.methods.includes(req.method)) return deny({ ...base, denied: `${req.method} isn't allowed for ${svc.id} in this session` }, 403, started);

      const headers = new Headers();
      for (const [k, v] of req.headers) if (!HOP.includes(k) && !(AUTH_HEADERS as readonly string[]).includes(k)) headers.set(k, v);
      const credential = svc.hosts[host]!(opts.tokens.get(svc.id)!.reveal());
      for (const [k, v] of Object.entries(credential.headers ?? {})) headers.set(k, v);
      // A service's own key header is replaced too, whatever the agent put in it.
      for (const [k, v] of Object.entries(credential.query ?? {})) url.searchParams.set(k, v);

      let res: Response;
      try {
        res = await fetch(upstream(host) + url.pathname + url.search, {
          method: req.method,
          headers,
          body: req.body,
          redirect: "manual",
          // Pass bodies through byte for byte; the agent decompresses.
          decompress: false,
        });
      } catch (error) {
        return deny({ ...base, denied: `upstream unreachable: ${error instanceof Error ? error.message : String(error)}` }, 502, started);
      }
      const out = new Headers();
      for (const [k, v] of res.headers) if (!HOP.includes(k)) out.append(k, v);
      log({ at: new Date().toISOString(), ...base, status: res.status, ms: performance.now() - started });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    },
  });

  const reply = (socket: net.Socket, status: string, extra = "") => socket.end(`HTTP/1.1 ${status}\r\n${extra}content-length: 0\r\n\r\n`);

  const outer = net.createServer((client) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > 16_384) client.destroy();
        return;
      }
      client.off("data", onData);
      const head = buffered.subarray(0, end).toString("latin1");
      const rest = buffered.subarray(end + 4);
      const [, method, target] = /^(\S+) (\S+) HTTP\/1\.[01]/.exec(head) ?? [];
      const session = sessions.get(proxyUser(head) ?? "");
      if (!alive(session)) {
        // Some clients (git's libcurl) probe without credentials first and retry on the same
        // connection, so the 407 keeps it open.
        client.write('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="sikrets"\r\ncontent-length: 0\r\n\r\n');
        buffered = Buffer.from(rest);
        client.on("data", onData);
        if (buffered.length) onData(Buffer.alloc(0));
        return;
      }
      if (method !== "CONNECT" || !target) return reply(client, "501 Not Implemented", "x-sikrets-proxy: only HTTPS (CONNECT) is proxied\r\n");
      const [host, portText] = target.split(":");
      const port = Number(portText ?? 443);
      const intercept = port === 443 && hostToService.has(host!) && session.rules.has(hostToService.get(host!)!.id);
      if (!intercept && opts.onlyServices) {
        log({ at: new Date().toISOString(), session: session.token.slice(0, 10), service: null, host: host!, method: "CONNECT", path: "", status: 403, ms: 0, denied: "only bundle services are reachable" });
        return reply(client, "403 Forbidden", "x-sikrets-proxy: only this session's services are reachable\r\n");
      }
      const up = intercept ? net.connect(inner.port!, "127.0.0.1") : net.connect(port, host);
      const own = sockets.get(session.token) ?? new Set();
      sockets.set(session.token, own.add(client).add(up));
      // The source port is captured here: once the socket is destroyed it can't be read back, and
      // a stale entry would hand this session to whoever next connects from that port.
      let mappedPort: number | undefined;
      up.once("connect", () => {
        if (intercept && up.localPort) byPort.set((mappedPort = up.localPort), session);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) up.write(rest);
        client.pipe(up);
        up.pipe(client);
      });
      const close = () => {
        if (mappedPort !== undefined && byPort.get(mappedPort) === session) byPort.delete(mappedPort);
        mappedPort = undefined;
        own.delete(client);
        own.delete(up);
        client.destroy();
        up.destroy();
      };
      up.on("error", () => (up.connecting ? reply(client, "502 Bad Gateway") : close()));
      up.on("close", close);
      client.on("error", close);
      client.on("close", close);
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => outer.listen(0, "127.0.0.1", resolve));
  const port = (outer.address() as net.AddressInfo).port;

  /** Ends every connection of a session, including untouched tunnels the proxy can't inspect. */
  const cut = (token: string) => {
    for (const s of sockets.get(token) ?? []) s.destroy();
    sockets.delete(token);
  };

  /** The one way a session ends: only an open session can, and only once. */
  const end = (token: string, state: Exclude<SessionState, "open">) => {
    const s = sessions.get(token);
    if (!s || s.state !== "open") return;
    s.state = state;
    clearTimeout(s.timer);
    sessions.delete(token);
    cut(token);
    s.onEnd?.(state);
  };

  // setTimeout can't wait longer than about 24.8 days (it fires at once instead), and a sleeping
  // Mac delays timers, so the deadline is checked against the clock in steps of at most a minute.
  const arm = (s: Live) => {
    const left = s.expiresAt - Date.now();
    if (left <= 0) return end(s.token, "expired");
    s.timer = setTimeout(() => arm(s), Math.min(left, PROXY.expiryCheckMs));
    s.timer.unref?.();
  };

  return {
    port,
    /** Opens a session. `onEnd` hears how it ended (expired, revoked, or the proxy stopped). */
    open(bundle: string, rules: readonly Rule[], ttlMs: number, onEnd?: (state: Exclude<SessionState, "open">) => void): Session {
      for (const r of rules) if (!opts.tokens.has(r.service)) throw new Error(`No token for ${r.service}. Add one: sikrets proxy add ${r.service}`);
      const session: Live = { token: newToken(), bundle, rules: new Map(rules.map((r) => [r.service, r])), expiresAt: Date.now() + ttlMs, state: "open", onEnd };
      sessions.set(session.token, session);
      arm(session);
      return session;
    },
    revoke: (token: string) => end(token, "revoked"),
    async stop() {
      for (const token of [...sessions.keys()]) end(token, "stopped");
      outer.close();
      inner.stop(true);
    },
  };
}

export type Proxy = Awaited<ReturnType<typeof startProxy>>;
