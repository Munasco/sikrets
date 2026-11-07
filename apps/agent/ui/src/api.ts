// A small client for the parts of opencode's API the gateway forwards. The browser's login
// cookie authenticates every call; the gateway scopes sessions to it. (opencode's own
// @opencode/client works too, but brings Effect along; ten typed calls are lighter.)

export interface SessionInfo {
  id: string;
  title?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated?: number; busy?: number; idle?: number };
}

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  state: { status: "pending" | "running" | "completed" | "error"; input?: unknown; content?: Array<{ type: string; text?: string }>; error?: { message?: string } };
  time?: { created?: number; ran?: number; completed?: number };
}
export type AssistantPart = { type: "text"; text: string } | { type: "reasoning"; text?: string } | ToolPart;

export type Message =
  | { id: string; type: "user"; text: string; time: { created: number } }
  | { id: string; type: "assistant"; content: AssistantPart[]; time: { created: number; completed?: number }; finish?: string; error?: { message?: string } }
  | { id: string; type: "idle"; outcome?: string; time: { created: number } };

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  metadata?: { reason?: string };
}

/** A skill the server ships: picked in the composer with `$id`. */
export interface Skill {
  id: string;
  name: string;
  description?: string;
}

/** A slash command the server defines (`/name args`). */
export interface Command {
  name: string;
  description?: string;
  hint?: string;
}

/** An MCP server the gateway configured, with this login's switch. */
export interface McpServer {
  name: string;
  title?: string;
  description?: string;
  enabled: boolean;
  status: { status: "connected" | "pending" | "disabled" | "failed" | "needs_auth"; error?: string };
}

export interface Me {
  authed: boolean;
  gated: boolean;
  model: string;
  /** The gateway approves everything this login's agent asks for. */
  fullAccess?: boolean;
}

export interface Attestation {
  enclave: boolean;
  pcrs?: Record<string, string>;
  timestamp?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let signedOut: (() => void) | undefined;
/** Called when the gateway stops accepting this login (expired, revoked, or the code rotated). */
export function onSignedOut(fn: () => void) {
  signedOut = fn;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  if (res.status === 401 && path !== "/api/login") signedOut?.();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? body.message ?? `Error ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  me: () => call<Me>("/api/me"),
  login: (code: string) => post<{ ok: true }>("/api/login", { code }),
  logout: () => post<{ ok: true }>("/api/logout"),
  attestation: () => call<Attestation>("/api/attestation"),
  sessions: async () => (await call<{ data: SessionInfo[] }>("/api/session?limit=100")).data,
  create: async () => (await post<{ data: SessionInfo }>("/api/session")).data,
  remove: (id: string) => call<void>(`/api/session/${id}`, { method: "DELETE" }),
  /** Oldest first. */
  messages: async (id: string) => (await call<{ data: Message[] }>(`/api/session/${id}/message?limit=200`)).data.slice().reverse(),
  prompt: (id: string, text: string, skills: string[] = []) => post<unknown>(`/api/session/${id}/prompt`, { text, ...(skills.length ? { skills: skills.map((s) => ({ id: s })) } : {}) }),
  command: (id: string, name: string, text: string, skills: string[] = []) => post<void>(`/api/session/${id}/command`, { name, text, ...(skills.length ? { skills: skills.map((s) => ({ id: s })) } : {}) }),
  compact: (id: string) => post<unknown>(`/api/session/${id}/compact`),
  skills: async () => (await call<{ data: Skill[] }>("/api/skill")).data,
  commands: async () => (await call<{ data: Command[] }>("/api/command")).data,
  mcp: async () => (await call<{ data: McpServer[] }>("/api/mcp")).data,
  /** opencode's own connect/disconnect calls; the gateway keeps them per login. */
  mcpSwitch: (name: string, on: boolean) => post<void>(`/api/experimental/mcp/${encodeURIComponent(name)}/${on ? "connect" : "disconnect"}`),
  interrupt: (id: string) => post<unknown>(`/api/session/${id}/interrupt`),
  permissions: async (id: string) => (await call<{ data: PermissionRequest[] }>(`/api/session/${id}/permission`)).data,
  /** Every request waiting for a decision, across this login's sessions. */
  allPermissions: async () => (await call<{ data: PermissionRequest[] }>("/api/permission/request")).data,
  fullAccess: (on: boolean) => call<{ fullAccess: boolean }>("/api/full-access", { method: "PUT", body: JSON.stringify({ on }) }),
  reply: (id: string, request: string, decision: "once" | "always" | "reject") => post<void>(`/api/session/${id}/permission/${request}/reply`, { decision }),
};

export interface OcEvent {
  type: string;
  data: Record<string, unknown> & { sessionID?: string };
}

/** opencode's event stream (only this caller's sessions; the gateway filters it). Reconnects. */
export function subscribe(onEvent: (ev: OcEvent) => void, onState: (live: boolean) => void): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    source = new EventSource("/api/event");
    source.onopen = () => onState(true);
    source.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as OcEvent);
      } catch {}
    };
    source.onerror = () => {
      onState(false);
      source?.close();
      if (!closed) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
  };
}
