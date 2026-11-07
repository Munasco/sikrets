import type { Server } from "./opencode.ts";
import type { Owner } from "./pool.ts";
import { Expiring } from "./store.ts";

// Full access: an owner who turns it on gets every permission request in their sessions approved
// ("always") by the gateway itself, so the agent never stops to wait, even with no chat open.
// Off by default, per owner. It only skips the prompts: the agent's tools stay what they are (the
// Sikrets tools, opencode's built-in tools, and the MCP servers this owner left on). Each owner has
// their own instance (src/pool.ts), so every request an instance raises is its owner's.

export class FullAccess {
  /** Owners with it on, until their login expires (a cookie owner's entry goes with the cookie). */
  private on: Expiring;
  constructor(file?: string) {
    this.on = new Expiring(file);
  }
  has(owner: Owner | undefined) {
    return this.on.has(owner);
  }
  set(owner: Owner, on: boolean, until?: number) {
    if (on) this.on.add(owner, until);
    else this.on.delete(owner);
  }
}

interface Asked {
  id: string;
  sessionID: string;
}

/** Approves what full-access owners' instances ask for. */
export function autoApprove(access: FullAccess) {
  const approve = (oc: Server, r: Asked) =>
    oc
      .fetch(`/api/session/${encodeURIComponent(r.sessionID)}/permission/${encodeURIComponent(r.id)}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "always" }) })
      .catch(() => {});

  /** Approves what the owner's instance is already waiting on (when they turn it on). */
  async function pending(oc: Server) {
    const res = await oc.fetch("/api/permission/request").catch(() => undefined);
    const list = ((await res?.json().catch(() => undefined)) as { data?: Asked[] } | undefined)?.data ?? [];
    await Promise.all(list.map((r) => approve(oc, r)));
  }

  /** Watches one owner's instance until the returned function is called. */
  function attach(owner: Owner, oc: Server, retryMs = 2_000) {
    let stopped = false;
    let ctrl: AbortController | undefined;
    void (async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await oc.fetch("/api/event", { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(`event stream: ${res.status}`);
          // Requests raised before this stream opened (at start, or while it was down) have no
          // event left to see: approve them from the list, after every (re)connect.
          if (access.has(owner)) void pending(oc);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
              buf = buf.slice(i + 2);
              if (!data) continue;
              try {
                const ev = JSON.parse(data) as { type: string; data: Asked };
                if (ev.type === "permission.asked" && access.has(owner)) void approve(oc, ev.data);
              } catch {}
            }
          }
        } catch {}
        if (!stopped) await Bun.sleep(retryMs);
      }
    })();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }

  return { pending, attach };
}
