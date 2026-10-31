import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Landing page building blocks. White paper, cream cards with a hairline border, a serif
// display face for headlines and buttons, monospace for labels, one deep green for actions.

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1100px] px-5 sm:px-8", className)}>{children}</div>
}

/** Small mono label with a tan dot, above a headline. */
export function Eyebrow({ children, className, light }: { children: ReactNode; className?: string; light?: boolean }) {
  return (
    <p className={cn("flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em]", light ? "text-white/70" : "text-ink-soft", className)}>
      <span className="inline-block size-2 rounded-full bg-tan" aria-hidden />
      {children}
    </p>
  )
}

export function Headline({ children, sub, eyebrow, align = "left", light, className }: { children: ReactNode; sub?: ReactNode; eyebrow?: ReactNode; align?: "left" | "center"; light?: boolean; className?: string }) {
  return (
    <div className={cn(align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-3xl", className)}>
      {eyebrow && <Eyebrow light={light} className={cn("mb-6", align === "center" && "justify-center")}>{eyebrow}</Eyebrow>}
      <h2 className={cn("display text-balance text-[2.5rem] sm:text-5xl md:text-[3.75rem]", light ? "text-white" : "text-ink")}>{children}</h2>
      {sub && <p className={cn("mt-5 text-pretty text-[17px] leading-relaxed md:text-lg", light ? "text-white/75" : "text-ink-soft")}>{sub}</p>}
    </div>
  )
}

/** Cream card: title, one line of body, then a visual. */
export function Card({ title, body, children, className }: { title: string; body?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-2xl border border-line bg-cream p-5 sm:p-6", className)}>
      <h3 className="text-[1.35rem] font-medium tracking-[-0.01em] text-ink">{title}</h3>
      {body && <p className="mt-1.5 max-w-md text-[15px] leading-relaxed text-ink-soft">{body}</p>}
      {children && <div className="mt-6 flex flex-1 flex-col justify-end">{children}</div>}
    </div>
  )
}

/** White terminal or code panel with a titled strip. Lines are passed as children. */
export function Terminal({ title, children, className, size = "md" }: { title: string; children: ReactNode; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={cn("w-full overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]", className)}>
      <div className="flex items-center gap-1.5 border-b border-line-soft px-3.5 py-2">
        <span className="size-2 rounded-full bg-line" />
        <span className="size-2 rounded-full bg-line" />
        <span className="size-2 rounded-full bg-line" />
        <span className="ml-2 truncate font-mono text-[11px] text-muted">{title}</span>
      </div>
      <pre className={cn("whitespace-pre-wrap [overflow-wrap:anywhere] px-4 py-3.5 font-mono leading-[1.7] text-ink", size === "sm" ? "text-[11.5px]" : "text-[11.5px] sm:text-[12.5px]")}>{children}</pre>
    </div>
  )
}

export const chipColor = {
  tan: "bg-tan text-white",
  pine: "bg-pine text-white",
  teal: "bg-teal text-white",
  plum: "bg-plum text-white",
  rust: "bg-rust text-white",
  moss: "bg-moss text-white",
  ink: "bg-ink text-white",
  ghost: "bg-sand text-ink-soft",
} as const

/** Mono tag used in rule and ledger mocks. */
export function Chip({ children, color = "ghost", className }: { children: ReactNode; color?: keyof typeof chipColor; className?: string }) {
  return <span className={cn("inline-block rounded-[4px] px-1.5 py-[1px] font-mono text-[11.5px] leading-5", chipColor[color], className)}>{children}</span>
}

/** Text between chips in a rule. */
export function Kw({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11.5px] leading-5 text-ink-soft">{children}</span>
}

/** Pill button in the display face. */
export function Pill({ href, children, variant = "primary", className }: { href: string; children: ReactNode; variant?: "primary" | "outline" | "light"; className?: string }) {
  const styles = {
    primary: "bg-pine text-white hover:bg-pine-deep",
    outline: "border border-line bg-white text-ink hover:bg-cream",
    light: "bg-white text-ink hover:bg-cream",
  }[variant]
  return (
    <a href={href} className={cn("inline-flex h-11 items-center justify-center rounded-full px-5 font-serif text-[1.2rem] leading-none tracking-[-0.01em] transition-colors", styles, className)}>
      {children}
    </a>
  )
}

/** Hero button: white pill with a green arrow disc. */
export function HeroButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="group inline-flex h-12 items-center gap-3 rounded-full bg-white pl-1.5 pr-6 text-[15px] font-medium text-ink shadow-[0_10px_30px_rgba(20,30,25,0.18)] transition-transform hover:-translate-y-px motion-reduce:transition-none motion-reduce:hover:translate-y-0">
      <span className="grid size-9 place-items-center rounded-full bg-pine text-white">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none">
          <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {children}
    </a>
  )
}

/** Native <details> accordion: works without JavaScript and is keyboard accessible. */
export function Accordion({ items, defaultOpen = 0 }: { items: { q: string; a: ReactNode }[]; defaultOpen?: number }) {
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((it, i) => (
        <details key={it.q} open={i === defaultOpen} className="group py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-ink [&::-webkit-details-marker]:hidden">
            <span className="font-serif text-[1.45rem] leading-tight tracking-[-0.01em]">{it.q}</span>
            <svg className="size-4 shrink-0 text-muted transition-transform group-open:rotate-45 motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-soft">{it.a}</div>
        </details>
      ))}
    </div>
  )
}

/** A running agent session with its countdown and a revoke control. */
export function SessionCard() {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sand font-serif text-lg text-ink">C</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-ink">claude</p>
          <p className="truncate font-mono text-[11.5px] text-ink-soft">
            github, slack
          </p>
        </div>
        <span className="rounded-full border border-rust/40 px-3 py-1 font-serif text-[15px] leading-none text-rust">Revoke</span>
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-sand">
        <div className="drain h-full rounded-full bg-pine" style={{ width: "92%" }} />
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-ink-soft">
        <span>sks_7f3a9c…</span>
        <span className="text-ink">1h 12m left</span>
      </div>
    </div>
  )
}

/** Rows from a session's request log. */
export function SessionLog() {
  const rows: { method: string; service: string; what: string; status: string; color: keyof typeof chipColor }[] = [
    { method: "GET", service: "github", what: "/repos/acme/web/pulls", status: "200", color: "pine" },
    { method: "POST", service: "slack", what: "/api/chat.postMessage", status: "200", color: "pine" },
    { method: "DELETE", service: "github", what: "/repos/acme/web", status: "403", color: "rust" },
  ]
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <ul className="divide-y divide-line-soft font-mono text-[11.5px]">
        {rows.map((r) => (
          <li key={r.what} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="w-12 shrink-0 text-ink-soft">{r.method}</span>
            <span className="w-12 shrink-0 text-ink-soft">{r.service}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{r.what}</span>
            <Chip color={r.color} className="shrink-0 text-center">
              {r.status}
            </Chip>
          </li>
        ))}
        <li className="bg-cream px-3.5 py-2.5 text-rust">denied: DELETE isn&apos;t allowed for github in this session</li>
      </ul>
    </div>
  )
}

/** A line in a deny list: a cross and a monospace name. */
export function Denied({ items }: { items: string[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 font-mono text-[11.5px]">
      {items.map((x) => (
        <li key={x} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-ink">
          <span className="text-rust" aria-hidden>
            ✗
          </span>
          <span className="truncate">{x}</span>
        </li>
      ))}
    </ul>
  )
}

/** A big number with a caption, for the dark stats grid. */
export function Stat({ value, unit, label, className }: { value: string; unit?: string; label: string; className?: string }) {
  return (
    <div className={cn("flex flex-col justify-start px-6 py-8 sm:px-8 sm:py-10 md:justify-center", className)}>
      <p className="display text-[2.75rem] text-white sm:text-5xl">
        {value}
        {unit && <span className="ml-1 text-[0.5em] text-white/60">{unit}</span>}
      </p>
      <p className="mt-2 text-[15px] leading-snug text-white/70">{label}</p>
    </div>
  )
}

export function Check() {
  return (
    <svg className="mt-[3px] size-4 shrink-0 text-pine" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
