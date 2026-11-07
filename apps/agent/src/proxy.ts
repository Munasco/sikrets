import { readFileSync, writeFileSync } from "node:fs";
import { OPENCODE, PROXY } from "./constants.ts";
import type { Server } from "./opencode.ts";

// The gateway's view of opencode's API: a short allowlist. Stock opencode clients (the TUI with
// `opencode --server`, the desktop app, our own page) need sessions, messages, prompts, the event
// stream and permission replies, plus a handful of reads to render. Those are forwarded. Reads
// the clients make that would touch the host (files, git, shells, worktrees, MCP, plugins,
// integrations) get an empty answer built here, without asking opencode. Everything else is a 404.
//
// Each caller sees only its own sessions: the gateway records who created each one, and filters
// lists and the event stream to match. Every request runs at opencode's private working
// directory, whatever location the client asks for.

export type Owner = string;

interface Ctx {
  owner: Owner;
  oc: Server;
  /** Path parameters from the route pattern. */
  params: Record<string, string>;
}

type Body = Record<string, unknown>;

interface Route {
  method: string;
  path: string;
  /** Answer locally; opencode is never called. */
  stub?: (ctx: Ctx) => unknown;
  /** Rewrite a JSON request body before it is forwarded; return undefined to skip forwarding (204). */
  body?: (body: Body, ctx: Ctx) => Body | undefined | Promise<Body | undefined>;
  /** Post-process a JSON response. */
  json?: (data: unknown, ctx: Ctx) => unknown;
  /** Sends a message to the model: counts against the model rate limit. */
  model?: boolean;
}

const at = (ctx: Ctx) => ({ location: { directory: ctx.oc.directory } });
const empty = (ctx: Ctx) => ({ ...at(ctx), data: [] });
const pick = (body: Body, keys: string[]) => Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

/** Sessions and their owners. Oldest first, so the map doubles as an LRU. Saved next to
 * opencode's own data when a file is given, so a gateway restart doesn't orphan open chats
 * (opencode's desktop app fails to load when a tab's session turns into a 404). */
export class Owners {
  private map = new Map<string, { owner: Owner; at: number }>();
  constructor(private file?: string) {
    if (!file) return;
    try {
      this.map = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, { owner: Owner; at: number }>));
    } catch {}
  }
  own(session: string, owner: Owner) {
    this.map.set(session, { owner, at: Date.now() });
    while (this.map.size > PROXY.sessions) this.map.delete(this.map.keys().next().value!);
    if (this.file) writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
  }
  known(session: string) {
    return this.map.has(session);
  }
  owns(session: string, owner: Owner) {
    return this.map.get(session)?.owner === owner;
  }
  /** True when the text mentions no session, or only sessions this owner has. */
  visible(text: string, owner: Owner) {
    for (const m of text.matchAll(/ses_[A-Za-z0-9]{8,}/g)) if (!this.owns(m[0], owner)) return false;
    return true;
  }
}

export function routes(owners: Owners): Route[] {
  const mine = (data: unknown, ctx: Ctx) => {
    const d = data as { data?: Array<{ id?: string; sessionID?: string }> };
    if (Array.isArray(d?.data)) d.data = d.data.filter((s) => owners.owns(s.sessionID ?? s.id ?? "", ctx.owner));
    return d;
  };
  return [
    // Server, agent and model reads the clients render from.
    { method: "GET", path: "/api/info" },
    { method: "GET", path: "/api/agent" },
    { method: "GET", path: "/api/agent/:agentID" },
    { method: "GET", path: "/api/model" },
    { method: "GET", path: "/api/provider" },
    { method: "GET", path: "/api/config" },
    { method: "GET", path: "/api/location" },
    { method: "GET", path: "/api/project" },
    { method: "GET", path: "/api/event" },
    { method: "GET", path: "/api/experimental/migration/v1", stub: () => ({ status: "completed" }) },

    // Sessions: create, list, read, prompt, stop, permissions.
    {
      method: "POST",
      path: "/api/session",
      // Clients may choose the new session's id (the TUI does), but never one that exists:
      // opencode answers a create for an existing id with that session.
      body: async (b, ctx) => {
        const id = typeof b.id === "string" && !owners.known(b.id) && (await ctx.oc.fetch(`/api/session/${encodeURIComponent(b.id)}`)).status === 404 ? b.id : undefined;
        return { ...pick(b, ["title"]), ...(id ? { id } : {}), agent: OPENCODE.agent };
      },
      json: (data, ctx) => {
        const id = (data as { data?: { id?: string } })?.data?.id;
        if (id) owners.own(id, ctx.owner);
        return data;
      },
    },
    { method: "GET", path: "/api/session", json: mine },
    {
      method: "GET",
      path: "/api/session/active",
      json: (data, ctx) => {
        const d = data as { data?: Record<string, unknown> };
        if (d?.data) d.data = Object.fromEntries(Object.entries(d.data).filter(([id]) => owners.owns(id, ctx.owner)));
        return d;
      },
    },
    { method: "GET", path: "/api/session/:sessionID" },
    { method: "PATCH", path: "/api/session/:sessionID", body: (b) => pick(b, ["title"]) },
    { method: "DELETE", path: "/api/session/:sessionID" },
    { method: "GET", path: "/api/session/:sessionID/message" },
    { method: "GET", path: "/api/session/:sessionID/message/:messageID" },
    { method: "GET", path: "/api/session/:sessionID/context" },
    { method: "GET", path: "/api/session/:sessionID/inbox" },
    // Text only: attachments, skills and agent mentions could carry content the redaction doesn't
    // see (the plugin drops them too).
    { method: "POST", path: "/api/session/:sessionID/prompt", model: true, body: (b) => ({ ...pick(b, ["id", "delivery", "resume"]), text: String(b.text ?? "").slice(0, PROXY.promptChars) }) },
    { method: "POST", path: "/api/session/:sessionID/interrupt" },
    { method: "POST", path: "/api/session/:sessionID/view" },
    // The agent and model are fixed by the server's config; clients that pick one are acknowledged
    // and ignored.
    { method: "POST", path: "/api/session/:sessionID/agent", body: () => undefined },
    { method: "POST", path: "/api/session/:sessionID/model", body: () => undefined },
    { method: "GET", path: "/api/session/:sessionID/permission" },
    { method: "GET", path: "/api/session/:sessionID/permission/:requestID" },
    { method: "POST", path: "/api/session/:sessionID/permission/:requestID/reply", body: (b) => pick(b, ["decision", "message"]) },
    { method: "GET", path: "/api/permission/request", json: mine },
    { method: "GET", path: "/api/session/:sessionID/form" },
    { method: "GET", path: "/api/form", json: mine },

    // Reads that would describe or touch the host: answered empty, here.
    { method: "GET", path: "/api/fs/list", stub: empty },
    { method: "GET", path: "/api/fs/find", stub: empty },
    { method: "GET", path: "/api/vcs", stub: (ctx) => ({ ...at(ctx), data: { branch: {} } }) },
    { method: "GET", path: "/api/shell", stub: empty },
    { method: "GET", path: "/api/config/shell", stub: () => [] },
    { method: "GET", path: "/api/worktree", stub: () => [] },
    { method: "POST", path: "/api/worktree/refresh", stub: () => null },
    { method: "GET", path: "/api/mcp", stub: empty },
    { method: "GET", path: "/api/mcp/resource", stub: (ctx) => ({ ...at(ctx), data: { resources: [], templates: [] } }) },
    { method: "GET", path: "/api/reference", stub: empty },
    { method: "GET", path: "/api/plugin", stub: empty },
    { method: "GET", path: "/api/integration", stub: empty },
    { method: "GET", path: "/api/skill", stub: empty },
    { method: "GET", path: "/api/command", stub: empty },
    { method: "GET", path: "/api/permission/saved", stub: empty },
    { method: "GET", path: "/api/experimental/session/:sessionID/terminal", stub: () => ({ data: [] }) },
    { method: "POST", path: "/api/rpc/:rpcID/:method", stub: () => ({ output: null }) },
  ];
}

interface Compiled extends Route {
  re: RegExp;
  keys: string[];
}

function compile(r: Route): Compiled {
  const keys: string[] = [];
  const re = new RegExp(`^${r.path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  return { ...r, re, keys };
}

export interface Proxy {
  /** The response, or undefined when the path isn't on the allowlist. */
  handle(req: Request, owner: Owner, limit: () => string | undefined): Promise<Response | undefined>;
  owners: Owners;
}

export function proxy(oc: Server, owners = new Owners()): Proxy {
  const table = routes(owners).map(compile);
  const out = (data: unknown, status = 200) => (data === null ? new Response(null, { status: 204 }) : Response.json(data, { status }));

  async function handle(req: Request, owner: Owner, limit: () => string | undefined): Promise<Response | undefined> {
    const url = new URL(req.url);
    const route = table.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return undefined;
    const match = route.re.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
    const ctx: Ctx = { owner, oc, params };
    if (params.sessionID && !owners.owns(params.sessionID, owner)) return Response.json({ error: "Not found" }, { status: 404 });
    if (route.stub) return out(route.stub(ctx));
    if (route.model) {
      const busy = limit();
      if (busy) return Response.json({ error: busy }, { status: 429 });
    }

    // The client's location is ignored: opencode works in its own private directory.
    const query = new URLSearchParams([...url.searchParams].filter(([k]) => !k.startsWith("location")));
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "DELETE") {
      const raw = await req.text();
      if (raw.length > PROXY.bodyBytes) return Response.json({ error: "Too large" }, { status: 413 });
      let parsed: Body = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Body) : {};
      } catch {
        return Response.json({ error: "Expected JSON" }, { status: 400 });
      }
      const next = route.body ? await route.body(parsed, ctx) : parsed;
      if (next === undefined) return new Response(null, { status: 204 });
      delete next.location;
      body = JSON.stringify(next);
    }
    const res = await oc.fetch(url.pathname + (query.size ? `?${query}` : ""), {
      method: req.method,
      headers: { accept: req.headers.get("accept") ?? "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body,
      signal: req.signal,
    });

    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) return new Response(filterEvents(res.body!, owner), { status: res.status, headers: { "content-type": type, "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
    if (!type.includes("json")) return new Response(res.body, { status: res.status, headers: type ? { "content-type": type } : {} });
    const data = await res.json();
    return Response.json(route.json && res.ok ? route.json(data, ctx) : data, { status: res.status });
  }

  /** Passes through only events that concern no session, or this owner's sessions. */
  function filterEvents(body: ReadableStream<Uint8Array>, owner: Owner): ReadableStream<Uint8Array> {
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let buf = "";
    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i + 2);
            buf = buf.slice(i + 2);
            if (owners.visible(block, owner)) controller.enqueue(enc.encode(block));
          }
        },
      }),
    );
  }

  return { handle, owners };
}
