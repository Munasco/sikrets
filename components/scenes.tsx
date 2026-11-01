"use client"

import Image from "next/image"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { SikretsMark } from "@/components/logo"
import { cn } from "@/lib/utils"

// Looping product scenes. Each one plays a short story on a timer while it is on screen,
// and shows its final frame when the visitor prefers reduced motion.

/** Steps through `count` frames every `ms` while the element is visible. */
function useLoop(count: number, ms: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [step, setStep] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(count - 1)
      return
    }
    let timer: ReturnType<typeof setInterval> | undefined
    const io = new IntersectionObserver(([e]) => {
      clearInterval(timer)
      if (e.isIntersecting) timer = setInterval(() => setStep((s) => (s + 1) % count), ms)
    })
    io.observe(el)
    return () => {
      io.disconnect()
      clearInterval(timer)
    }
  }, [count, ms])
  return { ref, step }
}

/** A blurred landscape photo as the backdrop for a product window. */
export function SceneBackdrop({ src, children, className }: { src: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-sand", className)}>
      <Image src={src} alt="" fill sizes="(min-width: 768px) 60vw, 100vw" className="scale-125 object-cover opacity-80 blur-[2px]" />
      <div className="relative flex h-full items-center justify-center p-5 sm:p-8">{children}</div>
    </div>
  )
}

/** A small app window: mono title bar, white body. */
function Window({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full max-w-[30rem] overflow-hidden rounded-xl border border-white/80 bg-white shadow-[0_20px_60px_rgba(30,40,35,0.18)]", className)}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
        <SikretsMark size={12} />
        {title}
      </div>
      {children}
    </div>
  )
}

function Toast({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div className={cn("pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-forest px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg transition-all duration-500", show ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0")}>
      {children}
    </div>
  )
}

const tones = {
  ok: "bg-[#e7f2ea] text-[#2c7a4b]",
  warn: "bg-[#fbeee2] text-rust",
  busy: "bg-cream text-ink-soft",
  held: "bg-[#fbeee2] text-rust",
}

function Status({ tone, children }: { tone: keyof typeof tones; children: ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors duration-500", tones[tone])}>{children}</span>
}

/** A key leaks into a public repo, gets rotated, and the app never notices. */
export function LeakScene() {
  const { ref, step } = useLoop(5, 1700)
  const keys = [
    ["STRIPE_SECRET_KEY", "payments"],
    ["OPENAI_API_KEY", "llm"],
    ["GITHUB_TOKEN", "ci"],
    ["RESEND_API_KEY", "email"],
  ]
  const leak = [
    <Status key="0" tone="ok">Safe</Status>,
    <Status key="1" tone="warn">Found in a public repo</Status>,
    <Status key="2" tone="busy">
      <span className="size-2.5 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
      Rotating
    </Status>,
    <Status key="3" tone="ok">Rotated just now</Status>,
    <Status key="4" tone="ok">Rotated just now</Status>,
  ][step]
  return (
    <div ref={ref} className="relative w-full max-w-[30rem]">
      <Toast show={step >= 3}>Stripe key rotated. Nothing to redeploy.</Toast>
      <Window title="Keys">
        <ul className="divide-y divide-line text-[13px]">
          {keys.map(([k, app], i) => (
            <li key={k} className={cn("flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-500", i === 0 && step >= 1 && step <= 2 && "bg-[#fdf6ef]")}>
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px] text-ink">{k}</span>
                <span className="text-[11px] text-muted">{app}</span>
              </span>
              {i === 0 ? leak : <Status tone="ok">Safe</Status>}
            </li>
          ))}
        </ul>
      </Window>
    </div>
  )
}

/** Normal activity streams past; one thing is held until the owner decides. */
export function GuardScene() {
  const { ref, step } = useLoop(5, 1500)
  const feed = [
    ["MacBook", "Chrome updated"],
    ["Gmail", "Signed in from Toronto"],
    ["iPhone", "Backup finished"],
  ]
  return (
    <div ref={ref} className="relative w-full max-w-[30rem]">
      <Toast show={step >= 3}>Blocked. Evidence saved.</Toast>
      <Window title="Activity">
        <ul className="divide-y divide-line text-[13px]">
          {feed.map(([where, what], i) => (
            <li key={where} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0 truncate text-ink">
                <span className="text-muted">{where} · </span>
                {what}
              </span>
              <Status tone="ok">Normal</Status>
            </li>
          ))}
        </ul>
        <div className={cn("m-3 rounded-lg border border-[#f1d9c4] bg-[#fdf6ef] p-3.5 transition-all duration-500", step >= 1 ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0")}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-rust">Held</span>
            <span className="font-mono text-[11px] text-muted">MacBook</span>
          </div>
          <p className="mt-1.5 text-[13px] text-ink">invoice_oct.pdf.app wants your keychain.</p>
          <div className="mt-3 flex gap-2 whitespace-nowrap text-[12px] font-medium">
            <span className="rounded-full bg-white px-3 py-1 text-ink-soft">Allow once</span>
            <span className={cn("rounded-full px-3 py-1 transition-all duration-300", step >= 2 ? "scale-95 bg-forest text-white ring-2 ring-pine/30" : "bg-pine text-white")}>Keep blocked</span>
          </div>
        </div>
      </Window>
    </div>
  )
}

/** An agent calls an API through Sikrets: it holds a placeholder, Sikrets attaches the real key. */
export function AgentAccessScene() {
  const { ref, step } = useLoop(3, 1800)
  const checks = ["Policy checked", "Key attached", "Expires in 1 hour"]
  return (
    <div ref={ref} className="w-full max-w-[30rem]">
      <Window title="Agent access">
        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 px-4 py-6 text-center text-[12px]">
          <Node label="Claude Code" sub="holds a placeholder" />
          <Wire />
          <Node label="Sikrets" sub="attaches the key" strong />
          <Wire />
          <div className="space-y-1.5">
            {["Stripe", "GitHub", "OpenAI"].map((s, i) => (
              <div key={s} className={cn("rounded-md border px-2 py-1 transition-colors duration-500", step === i ? "border-pine bg-[#eef4f0] text-forest" : "border-line text-ink-soft")}>
                {s}
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-2 border-t border-line px-4 py-3">
          {checks.map((c, i) => (
            <Status key={c} tone={step >= i ? "ok" : "busy"}>
              {c}
            </Status>
          ))}
        </div>
      </Window>
    </div>
  )
}

function Node({ label, sub, strong }: { label: string; sub: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-lg border px-2 py-2.5", strong ? "border-pine bg-pine text-white" : "border-line bg-cream text-ink")}>
      <p className="font-medium">{label}</p>
      <p className={cn("mt-0.5 text-[10.5px] leading-tight", strong ? "text-white/70" : "text-muted")}>{sub}</p>
    </div>
  )
}

/** A line with a dot travelling along it. */
function Wire() {
  return (
    <div className="relative h-px w-6 bg-line sm:w-10">
      <span className="absolute -top-[3px] left-0 size-[7px] rounded-full bg-pine motion-safe:animate-[wire_1.8s_ease-in-out_infinite]" />
    </div>
  )
}

/** A question and an answer, typed out in turn. */
export function ChatScene() {
  const { ref, step } = useLoop(5, 1600)
  return (
    <div ref={ref} className="w-full max-w-[30rem]">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-night">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-white/50">
          <SikretsMark size={12} />
          Ask Sikrets
        </div>
        <div className="min-h-[15rem] space-y-3 p-4 text-[13px] leading-snug">
          <p className={cn("ml-auto max-w-[85%] rounded-lg bg-white/10 px-3 py-2 text-white transition-opacity duration-500", step >= 0 ? "opacity-100" : "opacity-0")}>
            Got a text from &ldquo;Chase&rdquo; asking me to confirm a $2,400 payment. Real?
          </p>
          {step === 1 && <p className="font-mono text-[11px] text-white/50 motion-safe:animate-pulse">Checking the link…</p>}
          <p className={cn("max-w-[90%] rounded-lg bg-[#eef4f0] px-3 py-2 text-forest transition-all duration-500", step >= 2 ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")}>
            No. The link goes to chase-verify.co, registered two days ago. I blocked it on your devices.
          </p>
          <p className={cn("ml-auto max-w-[85%] rounded-lg bg-white/10 px-3 py-2 text-white transition-opacity duration-500", step >= 3 ? "opacity-100" : "opacity-0")}>Did I click it last week?</p>
          <p className={cn("max-w-[90%] rounded-lg bg-[#eef4f0] px-3 py-2 text-forest transition-all duration-500", step >= 4 ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")}>
            No visits from any of your devices.
          </p>
        </div>
      </div>
    </div>
  )
}

/** The hero status card: new events slide in at the top. */
export function GuardFeed({ className }: { className?: string }) {
  const events = [
    "Rotated a Stripe key found on GitHub",
    "Held a sign-in from a new country",
    "Stopped an app reading your keychain",
    "Gave Claude Code GitHub access for 1h",
  ]
  const { ref, step } = useLoop(events.length, 2600)
  const shown = [0, 1].map((i) => events[(step - i + events.length) % events.length])
  return (
    <div ref={ref} className={cn("w-full max-w-sm rounded-2xl border border-white/70 bg-white/70 p-5 text-forest shadow-[0_20px_60px_rgba(40,50,45,0.15)] backdrop-blur-xl md:w-[22rem]", className)}>
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
      <p className="display mt-3 text-[1.45rem] sm:mt-4 sm:text-[1.6rem]">3 devices · 21 keys</p>
      <ul className="mt-4 hidden divide-y divide-forest/10 border-t border-forest/10 text-[14px] sm:block">
        {shown.map((what, i) => (
          <li key={what} className={cn("flex items-center justify-between gap-4 py-2.5", i === 0 && "motion-safe:animate-[feed-in_0.5s_ease-out]")}>
            <span className="flex min-w-0 items-center gap-2.5 text-ink">
              <svg className="size-4 shrink-0 text-pine" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="truncate">{what}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{i === 0 ? "now" : "2m"}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
