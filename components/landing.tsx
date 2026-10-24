import Image from "next/image"
import type { ReactNode } from "react"
import { SikretsTileMark } from "@/components/landing-mark"
import { cn } from "@/lib/utils"

// Landing page building blocks, in a monochrome editorial style: black canvas, white serif
// display type with one italic word, neutral greys, rounded cards with an image or mock on top
// and a one-line caption below.

export function Headline({ children, sub, align = "center", className }: { children: ReactNode; sub?: ReactNode; align?: "center" | "left"; className?: string }) {
  return (
    <div className={cn(align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-3xl", className)}>
      <h2 className="font-serif text-5xl leading-[1.02] tracking-tight text-white md:text-[4.25rem] [&_em]:italic">{children}</h2>
      {sub && <p className="mt-5 text-base text-neutral-400 md:text-lg">{sub}</p>}
    </div>
  )
}

export function Card({ title, body, image, alt, children, className, imageClassName }: { title: string; body: string; image?: string; alt?: string; children?: ReactNode; className?: string; imageClassName?: string }) {
  return (
    <div className={cn("group relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-neutral-900 to-neutral-950", className)}>
      <div className="relative min-h-60 flex-1 overflow-hidden">
        {image && <Image src={image} alt={alt ?? ""} fill sizes="(min-width: 1024px) 50vw, 100vw" className={cn("object-cover transition-transform duration-700 group-hover:scale-[1.03]", imageClassName)} />}
        {children && <div className="relative flex h-full items-center justify-center p-6">{children}</div>}
      </div>
      <div className="relative px-6 pb-6 pt-4">
        <p className="text-sm leading-relaxed text-neutral-400">
          <span className="font-medium text-white">{title}.</span> {body}
        </p>
      </div>
    </div>
  )
}

export function Mock({ title, lines, hot = [], className }: { title: string; lines: string[]; hot?: number[]; className?: string }) {
  return (
    <div className={cn("w-full overflow-hidden rounded-xl border border-white/10 bg-black/70 shadow-2xl shadow-black/60 backdrop-blur", className)}>
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3.5 py-2">
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="h-2 w-2 rounded-full bg-white/15" />
        <span className="ml-2 truncate font-mono text-[11px] text-neutral-500">{title}</span>
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[11.5px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={cn("whitespace-pre", hot.includes(i) ? "text-white" : "text-neutral-400")}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  )
}

/** Native <details> accordion: works without JavaScript and is keyboard accessible. */
export function Accordion({ items, defaultOpen = 0 }: { items: { q: string; a: ReactNode }[]; defaultOpen?: number }) {
  return (
    <div className="divide-y divide-white/10">
      {items.map((it, i) => (
        <details key={it.q} open={i === defaultOpen} className="group py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-white [&::-webkit-details-marker]:hidden">
            <span className="text-[15px] md:text-base">{it.q}</span>
            <svg className="h-4 w-4 shrink-0 text-neutral-500 transition-transform group-open:rotate-180" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400">{it.a}</div>
        </details>
      ))}
    </div>
  )
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="font-serif text-4xl text-white md:text-5xl">{value}</div>
      <div className="mt-1.5 text-xs text-neutral-500">{label}</div>
    </div>
  )
}

/** Email capture: a plain GET form, so it works without JavaScript. */
export function EmailForm({ action, cta, id }: { action: string; cta: string; id: string }) {
  return (
    <form action={action} method="get" className="flex w-full max-w-md items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] p-1.5 pl-4 backdrop-blur">
      <label htmlFor={id} className="sr-only">
        Work email
      </label>
      <input id={id} name="email" type="email" required placeholder="What's your email?" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-neutral-500" />
      <button type="submit" className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-colors hover:bg-neutral-200">
        {cta}
      </button>
    </form>
  )
}

/** The Sikrets mark as a glossy 3D app tile, built in CSS. */
export function MarkTile() {
  return (
    <div className="relative">
      <div className="absolute inset-0 -z-10 rounded-[2rem] bg-[#9ca99a]/25 blur-3xl" />
      <div className="flex h-36 w-36 items-center justify-center rounded-[2rem] border border-white/15 bg-gradient-to-b from-neutral-700 via-neutral-900 to-black shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_30px_60px_rgba(0,0,0,0.8)]">
        <SikretsTileMark />
      </div>
    </div>
  )
}

/** Secure-by-design illustration: one vault, every project holding stand-ins only. */
export function VaultDiagram() {
  const projects = [
    { name: "web", x: 20, y: 20 },
    { name: "agent", x: 80, y: 20 },
    { name: "ci", x: 20, y: 80 },
    { name: "worker", x: 80, y: 80 },
  ]
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-neutral-900 to-black">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 75" preserveAspectRatio="none" aria-hidden>
        {projects.map((p) => (
          <line key={p.name} x1="50" y1="37.5" x2={p.x} y2={p.y * 0.75} stroke="rgba(255,255,255,0.14)" strokeWidth="0.3" strokeDasharray="1 1" />
        ))}
      </svg>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <div className="absolute inset-0 -z-10 rounded-full bg-[#9ca99a]/20 blur-2xl" />
        <div className="rounded-xl border border-white/15 bg-black/80 px-5 py-3.5 shadow-2xl">
          <p className="text-[11px] uppercase tracking-widest text-neutral-500">vault</p>
          <p className="mt-1 font-mono text-sm text-white">ANTHROPIC_API_KEY</p>
          <p className="font-mono text-[11px] text-[#9ca99a]">encrypted · only you can read</p>
        </div>
      </div>
      {projects.map((p) => (
        <div key={p.name} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-neutral-950/90 px-3 py-2" style={{ left: `${p.x}%`, top: `${p.y}%` }}>
          <p className="text-[11px] text-neutral-500">{p.name}</p>
          <p className="font-mono text-[11px] text-neutral-300">sk-sikrets-…</p>
        </div>
      ))}
    </div>
  )
}
