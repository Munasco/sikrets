import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "./opencode.ts";
import type { Owner, Owners } from "./proxy.ts";

// Full access: an owner who turns it on gets every permission request in their sessions approved
// ("always") by the gateway itself, so the agent never stops to wait, even with no chat open.
// Off by default, per owner. It only skips the prompts: the agent's tools stay the Sikrets tools,
// and every built-in (shell, files, web) stays denied.

export class FullAccess {
  private on = new Set<Owner>();
  constructor(private file?: string) {
    if (!file) return;
    try {
      this.on = new Set(JSON.parse(readFileSync(file, "utf8")) as Owner[]);
    } catch {}
  }
  has(owner: Owner | undefined) {
    return owner !== undefined && this.on.has(owner);
  }
  set(owner: Owner, on: boolean) {
    if (on) this.on.add(owner);
    else this.on.delete(owner);
    if (this.file) writeFileSync(this.file, JSON.stringify([...this.on]), { mode: 0o600 });
  }
}

interface Asked {
  id: string;
  sessionID: string;
}

/** Watches opencode's events and approves what full-access owners' sessions ask for. */
export function autoApprove(oc: Server, owners: Owners, access: FullAccess) {
  let stopped = false;
  let ctrl: AbortController | undefined;

  const approve = (r: Asked) =>
    oc
      .fetch(`/api/session/${encodeURIComponent(r.sessionID)}/permission/${encodeURIComponent(r.id)}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "always" }) })
      .catch(() => {});

  /** Approves what this owner's sessions are already waiting on (when they turn it on). */
  async function pending(owner: Owner) {
    const res = await oc.fetch("/api/permission/request").catch(() => undefined);
    const list = ((await res?.json().catch(() => undefined)) as { data?: Asked[] } | undefined)?.data ?? [];
    await Promise.all(list.filter((r) => owners.owns(r.sessionID, owner)).map(approve));
  }

  async function watch() {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await oc.fetch("/api/event", { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
        const reader = res.body!.getReader();
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
              if (ev.type === "permission.asked" && access.has(owners.ownerOf(ev.data.sessionID))) void approve(ev.data);
            } catch {}
          }
        }
      } catch {}
      if (!stopped) await Bun.sleep(2_000);
    }
  }
  void watch();

  return {
    pending,
    stop() {
      stopped = true;
      ctrl?.abort();
    },
  };
}
