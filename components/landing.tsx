import Image from "next/image"
import type { ReactNode } from "react"
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
    <a href={href} className={cn("inline-flex h-11 items-center justify-center rounded-full px-5 text-[15px] font-medium leading-none transition-colors", styles, className)}>
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
            <span className="text-[17px] font-medium leading-tight">{it.q}</span>
            <svg className="size-4 shrink-0 text-muted transition-transform group-open:rotate-45 motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-soft">{it.a}</div>
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

/** A product, Infisical-style: a highlighted name and one sentence, then a bordered block with
 *  three short capabilities on one side and a live scene on a blurred photo on the other. */
export function ProductBlock({ name, line, points, scene, flip }: { name: string; line: string; points: [string, string][]; scene: ReactNode; flip?: boolean }) {
  return (
    <div>
      <h3 className="display inline bg-[#e3ece5] px-1.5 text-[2rem] text-forest md:text-[2.4rem]">{name}</h3>
      <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-ink-soft">{line}</p>
      <div className="mt-8 grid overflow-hidden rounded-2xl border border-line bg-white md:grid-cols-[1fr_1.5fr]">
        <ul className={cn("divide-y divide-line", flip && "md:order-2")}>
          {points.map(([label, body]) => (
            <li key={label} className="p-6 md:p-7">
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">{label}</p>
              <p className="mt-2 text-[15px] leading-relaxed text-ink">{body}</p>
            </li>
          ))}
        </ul>
        {scene}
      </div>
    </div>
  )
}

/** Light card: a photo or illustration on top, then a mono label and a serif line. */
export function MediaCard({ media, label, title, body, cta, className }: { media: ReactNode; label?: string; title: string; body?: string; cta?: { label: string; href: string }; className?: string }) {
  return (
    <div className={cn("flex h-full flex-col rounded-2xl bg-cream p-2.5", className)}>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-sand">{media}</div>
      <div className="flex flex-1 flex-col px-3.5 pb-4 pt-5 md:px-4 md:pb-5">
        {label && <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{label}</p>}
        <h3 className={cn("display text-[1.6rem] text-forest md:text-[1.75rem]", label && "mt-1.5")}>{title}</h3>
        {body && <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{body}</p>}
        {cta && (
          <Pill href={cta.href} variant="outline" className="mt-5 self-start">
            {cta.label}
          </Pill>
        )}
      </div>
    </div>
  )
}

export function CardPhoto({ src, alt }: { src: string; alt: string }) {
  return <Image src={src} alt={alt} fill sizes="(min-width: 768px) 33vw, 100vw" className="object-cover transition-transform duration-700 hover:scale-[1.03] motion-reduce:transition-none" />
}
