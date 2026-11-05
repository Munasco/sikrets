import { readFileSync, writeFileSync } from "node:fs";
import { COMMANDS, MCP, OPENCODE, PROXY, SKILLS } from "./constants.ts";
import type { Server } from "./opencode.ts";
import { McpSwitches, syncSession } from "./mcp-switch.ts";

// The gateway's view of opencode's API: a short allowlist. Stock opencode clients (the TUI with
// `opencode --server`, the desktop app, our own page) need sessions, messages, prompts, the event
// stream and permission replies, plus a handful of reads to render. Those are forwarded. Reads
// the clients make that would touch the host (files, git, shells, worktrees, MCP resources,
// plugins, integrations) get an empty answer built here, without asking opencode. Everything else
// is a 404.
//
// Skills, slash commands and MCP servers are listed as the gateway configured them (src/capabilities.ts):
// only our skills, only our commands, only our servers, with each login's own MCP switches.
//
// Each caller sees only its own sessions: the gateway records who created each one, and filters
// lists and the event stream to match. Every request runs at opencode's private working
// directory, whatever location the client asks for.

export type Owner = string;

interface Ctx {
  owner: Owner;
  oc: Server;
  switches: McpSwitches;
  /** Path parameters from the route pattern. */
  params: Record<string, string>;
}

type Body = Record<string, unknown>;

interface Route {
  method: string;
  path: string;
  /** Answer locally; opencode is never called. */
  stub?: (ctx: Ctx) => unknown;
  /** Rewrite a JSON request body before it is forwarded; return undefined to skip forwarding (204),
   * or a Response to answer with it instead. */
  body?: (body: Body, ctx: Ctx) => Body | Response | undefined | Promise<Body | Response | undefined>;
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
  sessionsOf(owner: Owner) {
    return [...this.map].filter(([, v]) => v.owner === owner).map(([id]) => id);
  }
  ownerOf(session: string): Owner | undefined {
    return this.map.get(session)?.owner;
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
  const list = <T>(data: unknown, fn: (items: T[]) => unknown[]) => {
    const d = data as { data?: T[] };
    if (Array.isArray(d?.data)) d.data = fn(d.data) as T[];
    return d;
  };
  /** Skill attachments: ids of our own skills only. */
  const skills = (v: unknown, ctx: Ctx) => {
    const ours = new Set(ctx.oc.capabilities.skills.map((s) => s.id));
    const ids = Array.isArray(v) ? v.map((s) => (s as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && ours.has(id)) : [];
    return ids.length ? { skills: [...new Set(ids)].slice(0, SKILLS.perPrompt).map((id) => ({ id })) } : {};
  };
  const text = (b: Body) => String(b.text ?? "").slice(0, PROXY.promptChars);
  /** opencode's connect/disconnect, per login: flips this owner's switch and tells the plugin. */
  const toggle = (on: boolean) => async (ctx: Ctx) => {
    if (!ctx.oc.capabilities.mcp[ctx.params.server!]) return Response.json({ error: "Not found" }, { status: 404 });
    ctx.switches.set(ctx.owner, ctx.params.server!, on);
    for (const s of owners.sessionsOf(ctx.owner)) await syncSession(ctx.oc, ctx.switches, s, ctx.owner);
    return null;
  };
  return [
    // Server, agent and model reads the clients render from.
    { method: "GET", path: "/api/info" },
    { method: "GET", path: "/api/agent" },
    { method: "GET", path: "/api/agent/:agentID" },
    { method: "GET", path: "/api/model" },
    { method: "GET", path: "/api/provider" },
    {
      method: "GET",
      path: "/api/config",
      // The MCP section holds servers' environment and headers, and the plugin's options mirror it.
      json: (data) => {
        for (const e of Array.isArray(data) ? (data as Array<{ info?: Record<string, unknown> }>) : []) {
          if (!e.info) continue;
          delete e.info.mcp;
          delete e.info.plugins;
        }
        return data;
      },
    },
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
      json: async (data, ctx) => {
        const id = (data as { data?: { id?: string } })?.data?.id;
        if (id) {
          owners.own(id, ctx.owner);
          await syncSession(ctx.oc, ctx.switches, id, ctx.owner);
        }
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
    // Text, plus our own skills by id: attachments, agent mentions and metadata could carry content
    // the redaction doesn't see (the plugin drops them too).
    { method: "POST", path: "/api/session/:sessionID/prompt", model: true, body: (b, ctx) => ({ ...pick(b, ["id", "delivery", "resume"]), text: text(b), ...skills(b.skills, ctx) }) },
    // Our slash commands only; the plugin redacts the expanded prompt like any other.
    {
      method: "POST",
      path: "/api/session/:sessionID/command",
      model: true,
      body: (b, ctx) => (typeof b.name === "string" && Object.hasOwn(COMMANDS, b.name) ? { ...pick(b, ["name", "delivery"]), text: text(b), ...skills(b.skills, ctx) } : Response.json({ error: "No such command" }, { status: 404 })),
    },
    { method: "POST", path: "/api/session/:sessionID/compact", model: true, body: (b) => pick(b, ["delivery"]) },
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

    // Skills, commands and MCP servers: what the gateway configured, nothing the host has.
    { method: "GET", path: "/api/skill", json: (d, ctx) => list<{ id: string; name: string; description?: string }>(d, (all) => {
      const ours = new Set(ctx.oc.capabilities.skills.map((s) => s.id));
      return all.filter((s) => ours.has(s.id)).map((s) => ({ id: s.id, name: s.name, ...(s.description ? { description: s.description } : {}) }));
    }) },
    { method: "GET", path: "/api/command", json: (d) => list<{ name: string }>(d, (all) => all.filter((c) => Object.hasOwn(COMMANDS, c.name)).map((c) => ({ ...c, hint: COMMANDS[c.name]!.hint }))) },
    { method: "GET", path: "/api/mcp", json: (d, ctx) => list<{ name: string; status: { status: string } }>(d, (all) => {
      const servers = ctx.oc.capabilities.mcp;
      return all.filter((m) => servers[m.name]).map((m) => {
        const on = ctx.switches.on(ctx.owner, m.name);
        return { ...m, status: on ? m.status : { status: MCP.off }, enabled: on, ...(servers[m.name]!.description ? { description: servers[m.name]!.description } : {}) };
      });
    }) },
    { method: "POST", path: "/api/experimental/mcp/:server/connect", stub: toggle(true) },
    { method: "POST", path: "/api/experimental/mcp/:server/disconnect", stub: toggle(false) },

    // Reads that would describe or touch the host: answered empty, here.
    { method: "GET", path: "/api/fs/list", stub: empty },
    { method: "GET", path: "/api/fs/find", stub: empty },
    { method: "GET", path: "/api/vcs", stub: (ctx) => ({ ...at(ctx), data: { branch: {} } }) },
    { method: "GET", path: "/api/shell", stub: empty },
    { method: "GET", path: "/api/config/shell", stub: () => [] },
    { method: "GET", path: "/api/worktree", stub: () => [] },
    { method: "POST", path: "/api/worktree/refresh", stub: () => null },
    { method: "GET", path: "/api/mcp/resource", stub: (ctx) => ({ ...at(ctx), data: { resources: [], templates: [] } }) },
    { method: "GET", path: "/api/reference", stub: empty },
    { method: "GET", path: "/api/plugin", stub: empty },
    { method: "GET", path: "/api/integration", stub: empty },
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
  switches: McpSwitches;
}

export function proxy(oc: Server, owners = new Owners(), switches = new McpSwitches(oc.capabilities.mcp)): Proxy {
  const table = routes(owners).map(compile);
  const out = (data: unknown, status = 200) => (data instanceof Response ? data : data === null ? new Response(null, { status: 204 }) : Response.json(data, { status }));

  async function handle(req: Request, owner: Owner, limit: () => string | undefined): Promise<Response | undefined> {
    const url = new URL(req.url);
    const route = table.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return undefined;
    const match = route.re.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
    const ctx: Ctx = { owner, oc, switches, params };
    if (params.sessionID && !owners.owns(params.sessionID, owner)) return Response.json({ error: "Not found" }, { status: 404 });
    if (route.stub) return out(await route.stub(ctx));
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
      if (next instanceof Response) return next;
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
    return Response.json(route.json && res.ok ? await route.json(data, ctx) : data, { status: res.status });
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

  return { handle, owners, switches };
}
