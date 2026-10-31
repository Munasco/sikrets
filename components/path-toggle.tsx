"use client"

import { useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

type Mode = "before" | "after"

/** A node in the access graph: a small card with a type label and a name. */
function Node({ kind, name, critical, stack }: { kind: string; name: string; critical?: boolean; stack?: boolean }) {
  return (
    <div className="relative shrink-0">
      {stack && (
        <>
          <div className="absolute inset-0 translate-x-2 translate-y-2 rounded-xl border border-line bg-white" aria-hidden />
          <div className="absolute inset-0 translate-x-1 translate-y-1 rounded-xl border border-line bg-white" aria-hidden />
        </>
      )}
      <div className={cn("relative min-w-[9.5rem] rounded-xl border bg-white px-3.5 py-2.5 text-center shadow-sm", critical ? "border-rust/40" : "border-line")}>
        <p className={cn("font-mono text-[10px] uppercase tracking-wider", critical ? "text-rust" : "text-muted")}>{kind}</p>
        <p className="mt-0.5 font-mono text-[12.5px] text-ink">{name}</p>
      </div>
    </div>
  )
}

/** The connection between two nodes. Horizontal on wide screens, vertical on phones. */
function Edge({ label, state }: { label: ReactNode; state: "standing" | "grant" | "plain" }) {
  const color = state === "standing" ? "var(--color-rust)" : state === "grant" ? "var(--color-pine)" : "var(--color-faint)"
  return (
    <div className="relative flex h-16 w-full items-center justify-center md:h-auto md:min-h-16 md:flex-1">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <line x1="50%" y1="0" x2="50%" y2="100%" stroke={color} strokeWidth="1.5" className={cn("md:hidden", state === "grant" && "flow")} />
        <line x1="0" y1="50%" x2="100%" y2="50%" stroke={color} strokeWidth="1.5" className={cn("hidden md:block", state === "grant" && "flow")} />
      </svg>
      <span
        className={cn("relative z-10 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] leading-5 transition-colors duration-500", state === "standing" ? "bg-rust text-white" : state === "grant" ? "bg-pine text-white" : "bg-cream text-ink-soft")}
      >
        {label}
      </span>
    </div>
  )
}

/** The Binance path as an access graph, before and after standing access becomes a grant. */
export function PathToggle() {
  const [mode, setMode] = useState<Mode>("before")
  const after = mode === "after"
  const hop = (standingLabel: string) => (after ? { state: "grant" as const, label: "grant · 45 min" } : { state: "standing" as const, label: standingLabel })
  const first = hop("kubectl exec")
  const last = hop("signs anything")

  return (
    <div className="rounded-2xl border border-line bg-cream p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={cn("flex items-center gap-2 font-mono text-[12px] transition-colors", after ? "text-pine" : "text-rust")}>
          <span aria-hidden>{after ? "✓" : "✗"}</span>
          {after ? "0 of 6 entry points reach a critical action." : "2 of 6 entry points reach a critical action through standing access alone."}
        </p>
        <div role="tablist" aria-label="Access graph state" className="flex rounded-full border border-line bg-white p-0.5">
          {(["before", "after"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn("rounded-full px-3.5 py-1.5 font-mono text-[12px] transition-colors", mode === m ? "bg-ink text-white" : "text-ink-soft hover:text-ink")}
            >
              {m === "before" ? "As it was" : "With Sikrets"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-line bg-white/60 p-4 sm:p-6">
        <div className="flex flex-col items-center md:flex-row md:items-center">
          <Node kind="device" name="devops-laptop" critical={!after} />
          <Edge state={first.state} label={first.label} />
          <Node kind="service" name="withdrawal-service" />
          <Edge state="plain" label="signing API" />
          <Node kind="service" name="hot-wallet-signer" />
          <Edge state={last.state} label={last.label} />
          <Node kind="critical" name="11 hot wallets" critical stack />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] text-ink-soft">
        <span className="flex items-center gap-2">
          <i className="inline-block h-0.5 w-5 bg-rust" aria-hidden /> standing access
        </span>
        <span className="flex items-center gap-2">
          <i className="inline-block h-0.5 w-5 bg-pine" aria-hidden /> time-limited grant
        </span>
        <span className="flex items-center gap-2">
          <i className="inline-block h-0.5 w-5 bg-faint" aria-hidden /> not an attack path
        </span>
      </div>
    </div>
  )
}
