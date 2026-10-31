import Image from "next/image"
import type { ReactNode } from "react"
import { SikretsMark } from "@/components/logo"
import { cn } from "@/lib/utils"

// Landing page building blocks. White page, light grey rounded cards, pastel photography,
// a serif display face in dark green for headlines, monospace for labels, one deep green for actions.

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1100px] px-5 sm:px-8", className)}>{children}</div>
}

/** Small mono label with a green dot, above a statement. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft", className)}>
      <span className="inline-block size-2 rounded-full bg-pine" aria-hidden />
      {children}
    </p>
  )
}

/** A section opener: mono eyebrow, then a large serif statement in soft grey with the key words
 *  (wrapped in <b>) in dark green. */
export function Headline({ children, eyebrow, align = "left", className }: { children: ReactNode; eyebrow?: ReactNode; align?: "left" | "center"; className?: string }) {
  return (
    <div className={cn(align === "center" ? "mx-auto max-w-4xl text-center" : "max-w-4xl", className)}>
      {eyebrow && <Eyebrow className={cn("mb-6", align === "center" && "justify-center")}>{eyebrow}</Eyebrow>}
      <h2 className="display text-balance text-[2.4rem] text-faint sm:text-5xl md:text-[3.6rem] [&_b]:font-normal [&_b]:text-forest">{children}</h2>
    </div>
  )
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

export function Check() {
  return (
    <svg className="mt-[3px] size-4 shrink-0 text-pine" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Light card: a photo or illustration on top, then a mono label and a serif line. */
export function MediaCard({ media, label, title, body, className }: { media: ReactNode; label?: string; title: string; body?: string; className?: string }) {
  return (
    <div className={cn("flex h-full flex-col rounded-2xl bg-cream p-2.5", className)}>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-sand">{media}</div>
      <div className="px-3.5 pb-4 pt-5 md:px-4 md:pb-5">
        {label && <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{label}</p>}
        <h3 className={cn("display text-[1.9rem] text-forest md:text-[2.1rem]", label && "mt-2")}>{title}</h3>
        {body && <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{body}</p>}
      </div>
    </div>
  )
}

export function CardPhoto({ src, alt }: { src: string; alt: string }) {
  return <Image src={src} alt={alt} fill sizes="(min-width: 768px) 33vw, 100vw" className="object-cover transition-transform duration-700 hover:scale-[1.03] motion-reduce:transition-none" />
}

/** The guard's status, frosted white over the hero photo: on duty, what it watches, what it just did. */
export function GuardCard({ className }: { className?: string }) {
  const events = [
    { what: "Agent used a key it never saw", when: "now" },
    { what: "Upstash key rotated", when: "2m" },
  ]
  return (
    <div className={cn("w-full max-w-sm rounded-2xl border border-white/70 bg-white/70 p-5 text-forest shadow-[0_20px_60px_rgba(40,50,45,0.15)] backdrop-blur-xl md:w-[21rem]", className)}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[0.08em] text-ink-soft">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#3fae6f] opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-[#3fae6f]" />
          </span>
          On duty
        </span>
        <SikretsMark size={16} />
      </div>
      <p className="display mt-3 text-[1.6rem] sm:mt-4 sm:text-[1.8rem]">Watching 12 keys · 3 agents</p>
      <ul className="mt-4 hidden divide-y divide-forest/10 border-t border-forest/10 text-[14px] sm:block">
        {events.map((e) => (
          <li key={e.what} className="flex items-center justify-between gap-4 py-2.5">
            <span className="flex min-w-0 items-center gap-2.5 text-ink">
              <svg className="size-4 shrink-0 text-pine" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="truncate">{e.what}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{e.when}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* Small product sketches for the "How it works" cards: white panels on the card's grey well. */

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6">
      <div className="w-full max-w-[18rem] rounded-xl bg-white p-4 shadow-[0_8px_30px_rgba(40,50,45,0.08)]">{children}</div>
    </div>
  )
}

const Lock = () => (
  <svg className="size-3.5 shrink-0 text-pine" viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

export function VaultArt() {
  return (
    <Panel>
      <ul className="space-y-2.5 font-mono text-[12px] text-ink-soft">
        {["UPSTASH_TOKEN", "ANTHROPIC_KEY", "AWS_SECRET"].map((k) => (
          <li key={k} className="flex items-center justify-between gap-3 rounded-lg bg-cream px-3 py-2">
            <span className="truncate">{k}</span>
            <Lock />
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export function StandInArt() {
  return (
    <Panel>
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">.env</p>
      <p className="mt-3 truncate rounded-lg bg-cream px-3 py-2 font-mono text-[12px] text-ink-soft">
        UPSTASH_TOKEN=<span className="text-pine">sk_standin_••••</span>
      </p>
    </Panel>
  )
}

export function RotateArt() {
  return (
    <Panel>
      <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
        <span>Rotation</span>
        <span>30d</span>
      </div>
      <div className="mt-4 flex items-center gap-1.5">
        {[1, 1, 1, 0.35, 0.35, 0.35].map((o, i) => (
          <span key={i} className="h-2 flex-1 rounded-full bg-pine" style={{ opacity: o }} />
        ))}
      </div>
    </Panel>
  )
}
