import { useEffect, useRef, useState } from "react";
import { Plug } from "lucide-react";
import type { McpServer } from "./api.ts";
import { cn, Tip } from "./ui.tsx";

// The MCP servers the gateway configured, with this login's switches. A server that's off is gone
// from the agent's tools in every chat of this login; other logins keep their own switches.

const STATUS: Record<McpServer["status"]["status"], { dot: string; label: string }> = {
  connected: { dot: "bg-pine", label: "Connected" },
  pending: { dot: "bg-tan animate-pulse", label: "Connecting" },
  disabled: { dot: "bg-faint", label: "Off" },
  failed: { dot: "bg-rust", label: "Failed" },
  needs_auth: { dot: "bg-tan", label: "Needs sign-in on the server" },
};

export function McpMenu({ servers, onSwitch }: { servers: McpServer[]; onSwitch: (name: string, on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!servers.length) return null;
  const on = servers.filter((s) => s.enabled).length;
  return (
    // The list opens over the composer (its nearest positioned box), so it fits on a phone.
    <span ref={box} className="inline-flex">
      <Tip label={open ? "" : "MCP servers the agent can use. Their tools ask first, unless Full access is on."} className={open ? "[&>[role=tooltip]]:hidden" : undefined}>
        <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors", open ? "bg-cream text-ink" : "text-muted hover:text-ink")}>
          <Plug className="size-3.5" aria-hidden />
          <span className="max-sm:hidden">MCP</span>
          <span className="font-mono text-[11px] tabular-nums text-faint">{on}/{servers.length}</span>
        </button>
      </Tip>
      {open && (
        <div role="dialog" aria-label="MCP servers" className="absolute bottom-full left-0 z-30 mb-2 w-[min(320px,100%)] rounded-xl border border-line bg-white p-1 shadow-[0_8px_24px_-12px_rgb(20_30_25/25%)]">
          <p className="px-2.5 pb-1 pt-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">MCP servers</p>
          <ul>
            {servers.map((s) => {
              const st = STATUS[s.status.status] ?? STATUS.failed;
              return (
                <li key={s.name} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
                  <span className={cn("size-1.5 shrink-0 rounded-full", st.dot)} role="img" aria-label={st.label} title={s.status.error ? `${st.label}: ${s.status.error}` : st.label} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">{s.title ?? s.name}</span>
                      {s.title && <span className="shrink-0 font-mono text-[11px] text-faint">{s.name}</span>}
                    </span>
                    {s.description && <span className="block truncate text-[12px] text-faint">{s.description}</span>}
                  </span>
                  <button type="button" role="switch" aria-checked={s.enabled} aria-label={`${s.title ?? s.name}`} onClick={() => onSwitch(s.name, !s.enabled)} className={cn("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", s.enabled ? "bg-pine" : "bg-sand")}>
                    <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-white shadow-xs transition-[left]", s.enabled ? "left-[16px]" : "left-[2px]")} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </span>
  );
}
