import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** A box in the diagram: a mono kind label, a name and an optional detail line. */
function Box({ kind, name, detail, tone = "plain", className }: { kind: string; name: string; detail?: ReactNode; tone?: "plain" | "pine"; className?: string }) {
  return (
    <div className={cn("relative w-full max-w-[15rem] rounded-xl border bg-white px-4 py-3 text-center shadow-sm md:w-auto md:min-w-[11rem]", tone === "pine" ? "border-pine/40" : "border-line", className)}>
      <p className={cn("font-mono text-[10px] uppercase tracking-wider", tone === "pine" ? "text-pine" : "text-muted")}>{kind}</p>
      <p className="mt-0.5 font-mono text-[13px] text-ink">{name}</p>
      {detail && <p className="mt-1.5 font-mono text-[11px] text-ink-soft">{detail}</p>}
    </div>
  )
}

/** A labelled connector. Vertical on phones, horizontal from md up. */
function Wire({ label, tone }: { label: string; tone: "muted" | "pine" }) {
  const color = tone === "pine" ? "var(--color-pine)" : "var(--color-faint)"
  return (
    <div className="relative flex h-16 w-full items-center justify-center md:h-auto md:min-h-16 md:min-w-24 md:flex-1">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <line x1="50%" y1="0" x2="50%" y2="100%" stroke={color} strokeWidth="1.5" className="flow md:hidden" />
        <line x1="0" y1="50%" x2="100%" y2="50%" stroke={color} strokeWidth="1.5" className="flow hidden md:block" />
      </svg>
      <span className={cn("relative z-10 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] leading-5", tone === "pine" ? "bg-pine text-white" : "bg-cream text-ink-soft")}>{label}</span>
    </div>
  )
}

/** How a session request travels: the sandboxed agent holds a session token, the local proxy swaps
 *  in the real key, and only then does the request reach the service. */
export function SessionFlow() {
  return (
    <div className="rounded-2xl border border-line bg-cream p-4 sm:p-6">
      <div className="flex flex-col items-center md:flex-row md:items-stretch">
        <div className="flex w-full flex-col items-center rounded-xl border border-dashed border-rust/40 px-3 pb-3 pt-2 md:w-auto">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-rust">macOS sandbox</p>
          <Box kind="agent" name="claude" detail="GITHUB_TOKEN=sks_7f3a…" />
          <p className="mt-2 font-mono text-[10.5px] text-ink-soft">no keychain · no ~/.ssh · no direct network</p>
        </div>
        <Wire label="session token" tone="muted" />
        <div className="flex items-center">
          <Box kind="on your machine" name="sikrets proxy" detail="checks · swaps key · logs" tone="pine" />
        </div>
        <Wire label="real key" tone="pine" />
        <div className="flex flex-col items-center justify-center gap-2">
          <Box kind="service" name="api.github.com" />
          <Box kind="service" name="slack.com" />
        </div>
      </div>
    </div>
  )
}
