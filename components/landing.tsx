import Image from "next/image"
import type { ReactNode } from "react"
import { SikretsMark } from "@/components/logo"
import { cn } from "@/lib/utils"

// Landing page building blocks. White paper, cream cards with a hairline border, photo cards,
// a serif display face for headlines and buttons, monospace for labels, one deep green for actions.

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

/** Photo card: a full-bleed image with a title and one line over a dark fade. */
export function PhotoCard({ image, alt, title, body, className }: { image: string; alt: string; title: string; body: string; className?: string }) {
  return (
    <div className={cn("relative flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-2xl bg-night p-6 text-white md:aspect-[4/5]", className)}>
      <Image src={image} alt={alt} fill sizes="(min-width: 768px) 33vw, 100vw" className="object-cover transition-transform duration-700 hover:scale-[1.03] motion-reduce:transition-none" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
      <div className="pointer-events-none relative">
        <h3 className="display text-[2rem]">{title}</h3>
        <p className="mt-1.5 text-[15px] leading-relaxed text-white/75">{body}</p>
      </div>
    </div>
  )
}

/** The guard's status, floating over the hero photo: on duty, what it watches, what it just did. */
export function GuardCard() {
  const events = [
    { what: "Agent used a key it never saw", when: "now" },
    { what: "Upstash key rotated", when: "2m" },
  ]
  return (
    <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-white/10 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl md:w-[22rem]">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 font-mono text-[12px] uppercase tracking-[0.08em]">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#7ee2a8] opacity-70 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-[#7ee2a8]" />
          </span>
          On duty
        </span>
        <SikretsMark size={16} />
      </div>
      <p className="display mt-4 text-[1.9rem]">Watching 12 keys · 3 agents</p>
      <ul className="mt-4 divide-y divide-white/10 border-t border-white/10 text-[14px]">
        {events.map((e) => (
          <li key={e.what} className="flex items-center justify-between gap-4 py-2.5">
            <span className="flex min-w-0 items-center gap-2.5 text-white/85">
              <svg className="size-4 shrink-0 text-[#7ee2a8]" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="truncate">{e.what}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-white/50">{e.when}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
