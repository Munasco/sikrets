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

export interface Me {
  authed: boolean;
  gated: boolean;
  model: string;
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

/** Called when the gateway says the login is gone (401), so the page can go back to the code gate. */
let signedOut: () => void = () => {};
export const onSignedOut = (cb: () => void) => {
  signedOut = cb;
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  if (res.status === 401 && path !== "/api/login") signedOut();
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
  attestation: () => call<Attestation>("/api/attestation"),
  sessions: async () => (await call<{ data: SessionInfo[] }>("/api/session?limit=100")).data,
  create: async () => (await post<{ data: SessionInfo }>("/api/session")).data,
  remove: (id: string) => call<void>(`/api/session/${id}`, { method: "DELETE" }),
  /** Oldest first. */
  messages: async (id: string) => (await call<{ data: Message[] }>(`/api/session/${id}/message?limit=200`)).data.slice().reverse(),
  prompt: (id: string, text: string) => post<unknown>(`/api/session/${id}/prompt`, { text }),
  interrupt: (id: string) => post<unknown>(`/api/session/${id}/interrupt`),
  permissions: async (id: string) => (await call<{ data: PermissionRequest[] }>(`/api/session/${id}/permission`)).data,
  reply: (id: string, request: string, decision: "once" | "always" | "reject") => post<void>(`/api/session/${id}/permission/${request}/reply`, { decision }),
};

export interface OcEvent {
  type: string;
  data: Record<string, unknown> & { sessionID?: string };
}

/**
 * opencode's event stream (only this caller's sessions; the gateway filters it). Reconnects.
 * `onState(true, true)` means it came back after a drop: events in between are lost, so resync.
 * EventSource can't see the status code, so after a drop it asks /api/me and stops if signed out.
 */
export function subscribe(onEvent: (ev: OcEvent) => void, onState: (live: boolean, reconnected: boolean) => void): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let dropped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reopen = () =>
    api.me().then(
      (me) => {
        if (closed) return;
        if (!me.authed) return signedOut();
        open();
      },
      () => !closed && (retry = setTimeout(reopen, 2000)),
    );
  const open = () => {
    source = new EventSource("/api/event");
    source.onopen = () => {
      onState(true, dropped);
      dropped = false;
    };
    source.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as OcEvent);
      } catch {}
    };
    source.onerror = () => {
      dropped = true;
      onState(false, false);
      source?.close();
      if (!closed) retry = setTimeout(reopen, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
  };
}
