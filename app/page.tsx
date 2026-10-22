import { HugeiconsIcon } from "@hugeicons/react"
import {
  Key01Icon,
  Plug01Icon,
  RefreshIcon,
  FingerPrintIcon,
  ServerStack01Icon,
  Shield01Icon,
  AiBrain01Icon,
  CommandLineIcon,
  WorkflowSquare01Icon,
  CubeIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Frame } from "@/components/frame"
import { Wordmark } from "@/components/logo"
import { RotatingWord } from "@/components/rotating-word"

const tennantUrl = "https://usetennant.com"
const waitlistUrl = `${tennantUrl}/waitlist`
const demoUrl = "https://cal.com/munachi-ernest-eze/custom?duration=20"

const subjects = ["agent.", "app.", "MCP server.", "pipeline.", "sandbox."]

const liveKeys = [
  { owner: "research-agent", service: "openai", ttl: "rotates in 14m" },
  { owner: "github-mcp", service: "github", ttl: "rotates in 52m" },
  { owner: "nightly-etl", service: "postgres", ttl: "rotates in 3h" },
  { owner: "checkout-api", service: "stripe", ttl: "rotates in 6h" },
]

const scope = [
  { icon: AiBrain01Icon, label: "AI agents" },
  { icon: ServerStack01Icon, label: "Apps & services" },
  { icon: Plug01Icon, label: "MCP servers" },
  { icon: WorkflowSquare01Icon, label: "CI pipelines" },
  { icon: CubeIcon, label: "Sandboxes" },
]

const lifecycle = [
  {
    icon: Key01Icon,
    title: "Provision",
    body: "Declare what each project or agent needs. Sikrets creates the resource and its credentials, scoped to exactly that.",
    security: "No key ever passes through a human.",
  },
  {
    icon: CommandLineIcon,
    title: "Deliver",
    body: "Credentials are injected into the running process at start. Your code reads them like any other config.",
    security: "No .env files, nothing on disk or in CI logs.",
  },
  {
    icon: RefreshIcon,
    title: "Rotate",
    body: "Keys are replaced on a schedule, automatically, without redeploys or downtime.",
    security: "Anything stolen expires on its own.",
  },
]

const leaks = [
  { how: "Someone pastes a key into .env, Slack, or CI", why: "No one ever sees it—Sikrets created it" },
  { how: "A leaked key keeps working for months", why: "It's rotated out within hours" },
  { how: "Secrets baked into files and images", why: "Injected at runtime, never written down" },
  { how: "The secret store itself is breached", why: "Encrypted on your device; we hold only ciphertext" },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Wordmark />
          <nav className="flex items-center gap-2">
            <Button variant="ghost" className="hidden sm:inline-flex" asChild>
              <a href="#how-it-works">How it works</a>
            </Button>
            <Button variant="ghost" className="hidden sm:inline-flex" asChild>
              <a href="#security">Security</a>
            </Button>
            <Button asChild>
              <a href={waitlistUrl}>Join the beta</a>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="max-w-6xl mx-auto px-6 pt-20 pb-24 grid gap-16 lg:grid-cols-[1.15fr_1fr] items-center">
          <div className="space-y-8">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">Credentials for the agentic era</p>
            <div className="space-y-4">
              <h1 className="text-4xl md:text-6xl leading-[1.05] text-text">Credentials no one ever touches.</h1>
              <p className="text-2xl md:text-3xl leading-snug text-text-soft">
                Auto-provisioned, auto-rotated keys for every <RotatingWord words={subjects} />
              </p>
            </div>
            <p className="text-lg text-muted max-w-xl">
              Sikrets gives every agent and app its own credentials—created on demand, scoped to what it needs, and
              rotated before they can leak. No one copies a key. No one has to.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <a href={waitlistUrl}>Join the beta</a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href={demoUrl}>Book a demo</a>
              </Button>
            </div>
          </div>

          <Frame className="p-0">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <span className="text-text">Live credentials</span>
              <span className="flex items-center gap-2 font-mono text-xs text-sage">
                <span className="h-1.5 w-1.5 rounded-full bg-sage animate-pulse" />
                auto-rotating
              </span>
            </div>
            <div className="divide-y divide-line">
              {liveKeys.map((k) => (
                <div key={k.owner} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-text truncate">{k.owner}</p>
                    <p className="text-xs text-faint">{k.service} · provisioned by Sikrets</p>
                  </div>
                  <p className="font-mono text-xs text-label whitespace-nowrap">{k.ttl}</p>
                </div>
              ))}
            </div>
          </Frame>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20 space-y-10">
            <div className="max-w-2xl space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">The scope</p>
              <h2 className="text-3xl md:text-4xl text-text">Agents multiplied your credentials. Nobody can hand-manage them.</h2>
              <p className="text-muted leading-relaxed">
                Every agent, tool, and service now needs its own access to models, APIs, databases, and clouds. Sikrets
                is the identity and access layer for all of that non-human software.
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-line border border-line">
              {scope.map((s) => (
                <div key={s.label} className="bg-ink px-5 py-6 flex items-center gap-3">
                  <HugeiconsIcon icon={s.icon} className="h-5 w-5 text-sage shrink-0" />
                  <span className="text-sm text-text">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="border-t border-line scroll-mt-8">
          <div className="max-w-6xl mx-auto px-6 py-20 space-y-10">
            <div className="max-w-2xl space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">How it works</p>
              <h2 className="text-3xl md:text-4xl text-text">Provision. Deliver. Rotate. Repeat.</h2>
            </div>
            <div className="grid gap-px bg-line md:grid-cols-3 border border-line">
              {lifecycle.map((step) => (
                <div key={step.title} className="bg-ink p-8 flex flex-col gap-4">
                  <HugeiconsIcon icon={step.icon} className="h-6 w-6 text-sage" />
                  <h3 className="text-xl text-text">{step.title}</h3>
                  <p className="text-sm text-muted leading-relaxed flex-1">{step.body}</p>
                  <p className="flex items-start gap-2 pt-4 border-t border-line text-sm text-sage">
                    <HugeiconsIcon icon={Shield01Icon} className="h-4 w-4 mt-0.5 shrink-0" />
                    {step.security}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="security" className="border-t border-line scroll-mt-8">
          <div className="max-w-6xl mx-auto px-6 py-20 grid gap-12 lg:grid-cols-[1fr_1.2fr] items-start">
            <div className="space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">Security</p>
              <h2 className="text-3xl md:text-4xl text-text">Secure because no one is in the loop.</h2>
              <p className="text-muted leading-relaxed">
                Most keys leak through people: copied, pasted, forgotten. Take people out of the lifecycle and the usual
                leaks have nowhere to happen.
              </p>
            </div>
            <div className="border-[1.7px] border-line divide-y divide-line">
              <div className="grid grid-cols-2 gap-4 px-5 py-3 font-mono text-xs uppercase tracking-wider text-faint bg-surface">
                <span>How keys usually leak</span>
                <span>With Sikrets</span>
              </div>
              {leaks.map((row) => (
                <div key={row.how} className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
                  <span className="text-text">{row.how}</span>
                  <span className="text-sage">{row.why}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20 grid gap-12 lg:grid-cols-[1.1fr_1fr] items-center">
            <div className="space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">Coming next</p>
              <h2 className="text-3xl md:text-4xl text-text">Steal every stored key. They still won&apos;t work.</h2>
              <p className="text-muted leading-relaxed">
                We&apos;re building a credential broker: your real keys never leave Sikrets, and requests only get them
                attached when they prove they come from your authorized workload.
              </p>
            </div>
            <Frame className="p-6 md:p-8">
              <FlowDiagram />
            </Frame>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <Frame className="p-8 md:p-12 grid gap-8 md:grid-cols-[1fr_auto] items-center">
              <div className="space-y-3">
                <h2 className="text-2xl md:text-3xl text-text">Stop handling secrets.</h2>
                <p className="text-muted">Sikrets is in private beta. Join with your Tennant account.</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button size="lg" asChild>
                  <a href={waitlistUrl}>Join the beta</a>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <a href={demoUrl}>Book a demo</a>
                </Button>
              </div>
            </Frame>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col md:flex-row gap-4 md:items-center justify-between text-sm">
          <Wordmark />
          <p className="text-muted">
            A product of{" "}
            <a href={tennantUrl} className="text-text-soft hover:text-text underline-offset-4 hover:underline">
              Tennant
            </a>
          </p>
          <div className="flex gap-4 text-faint">
            <a href={`${tennantUrl}/terms`} className="hover:text-text">Terms</a>
            <a href={`${tennantUrl}/privacy`} className="hover:text-text">Privacy</a>
          </div>
        </div>
      </footer>
    </div>
  )
}

function FlowDiagram() {
  return (
    <div className="space-y-3 font-mono text-sm">
      <Node icon={AiBrain01Icon} label="Your agent or app" detail="stand-in credential + workload proof" />
      <Arrow />
      <Node icon={Shield01Icon} label="Sikrets" detail="verifies identity · attaches real key" highlight />
      <Arrow />
      <Node icon={Plug01Icon} label="OpenAI · Stripe · AWS" detail="sees a normal, authorized request" />
      <div className="flex items-center gap-3 pt-4 mt-2 border-t border-line text-xs text-danger">
        <HugeiconsIcon icon={FingerPrintIcon} className="h-4 w-4 shrink-0" />
        <span>Copied stand-in, no workload proof → rejected</span>
      </div>
    </div>
  )
}

function Node({ icon, label, detail, highlight }: { icon: typeof Key01Icon; label: string; detail: string; highlight?: boolean }) {
  return (
    <div className={highlight ? "flex items-center gap-4 border-[1.7px] border-sage bg-field px-4 py-3" : "flex items-center gap-4 border border-line px-4 py-3"}>
      <HugeiconsIcon icon={icon} className="h-5 w-5 text-sage shrink-0" />
      <div className="min-w-0">
        <p className="text-text">{label}</p>
        <p className="text-xs text-muted">{detail}</p>
      </div>
    </div>
  )
}

function Arrow() {
  return <div className="ml-6 h-5 border-l border-dashed border-line-strong" aria-hidden />
}
