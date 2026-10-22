import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Key01Icon, Plug01Icon, RefreshIcon, FingerPrintIcon, ServerStack01Icon, Shield01Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Frame } from "@/components/frame"
import { Wordmark } from "@/components/logo"

const tennantUrl = "https://usetennant.com"
const waitlistUrl = `${tennantUrl}/waitlist`
const demoUrl = "https://cal.com/munachi-ernest-eze/custom?duration=20"

const steps = [
  {
    title: "Your real keys stay with Sikrets",
    body: "OpenAI, Stripe, AWS—the live credentials never leave the broker. Not in your env files, not on your hosting platform.",
  },
  {
    title: "Your app gets a stand-in",
    body: "Deploy with a substitute credential instead. On its own, it can't call anything.",
  },
  {
    title: "Every request proves where it runs",
    body: "Your app calls through Sikrets with proof of its running workload's identity, not another stored secret.",
  },
  {
    title: "Sikrets verifies, then forwards",
    body: "Only verified workloads get the real key attached to their request, within the limits you set.",
  },
]

const exposure = [
  { stolen: "Your stored stand-in credential", result: "Useless without workload proof", safe: true },
  { stolen: "Your database, env files, CI secrets", result: "No real keys in them to find", safe: true },
  { stolen: "A short-lived runtime token", result: "Expires in minutes, scoped to your limits", safe: true },
  { stolen: "Control of your running app itself", result: "Bounded by gateway limits and audit trail", safe: false },
]

const pillars = [
  { icon: Key01Icon, title: "Provision access", body: "Decide which application, environment, and service each credential can reach." },
  { icon: Plug01Icon, title: "Connect services", body: "Link the providers your projects depend on once, and broker every call to them." },
  { icon: RefreshIcon, title: "Rotate credentials", body: "Swap a real key in one place. Nothing to redeploy, nothing to hunt down." },
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
            <Button asChild>
              <a href={waitlistUrl}>Join the beta</a>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="max-w-6xl mx-auto px-6 pt-20 pb-24 grid gap-16 lg:grid-cols-[1.1fr_1fr] items-center">
          <div className="space-y-8">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">Credential brokering</p>
            <h1 className="text-4xl md:text-6xl leading-[1.05] text-text">Steal every stored key. They still won&apos;t work.</h1>
            <p className="text-lg text-sage max-w-xl">
              Sikrets holds your real API keys and only hands their power to the applications you&apos;ve authorized.
              A home for your projects&apos; secrets and connections.
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

          <Frame className="p-6 md:p-8">
            <FlowDiagram />
          </Frame>
        </section>

        <section id="how-it-works" className="border-t border-line scroll-mt-8">
          <div className="max-w-6xl mx-auto px-6 py-20 space-y-12">
            <div className="max-w-2xl space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">How it works</p>
              <h2 className="text-3xl md:text-4xl text-text">Stop replacing one stealable secret with another.</h2>
            </div>
            <ol className="grid gap-px bg-line border border-line md:grid-cols-2 lg:grid-cols-4">
              {steps.map((s, i) => (
                <li key={s.title} className="bg-ink p-6 space-y-3">
                  <span className="font-mono text-xs text-faint">0{i + 1}</span>
                  <h3 className="text-text">{s.title}</h3>
                  <p className="text-sm text-muted leading-relaxed">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20 grid gap-12 lg:grid-cols-[1fr_1.2fr] items-start">
            <div className="space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">After a breach</p>
              <h2 className="text-3xl md:text-4xl text-text">What an attacker actually walks away with.</h2>
              <p className="text-muted leading-relaxed">
                Leaked env files and dumped databases are the usual way keys escape. With Sikrets, there&apos;s nothing reusable in them.
              </p>
            </div>
            <div className="border-[1.7px] border-line divide-y divide-line">
              <div className="grid grid-cols-2 gap-4 px-5 py-3 font-mono text-xs uppercase tracking-wider text-faint bg-surface">
                <span>They obtain</span>
                <span>Result</span>
              </div>
              {exposure.map((row) => (
                <div key={row.stolen} className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
                  <span className="text-text">{row.stolen}</span>
                  <span className={row.safe ? "text-sage" : "text-label"}>{row.result}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <div className="grid gap-px bg-line md:grid-cols-3 border border-line">
              {pillars.map((p) => (
                <div key={p.title} className="bg-ink p-8 space-y-4">
                  <HugeiconsIcon icon={p.icon} className="h-6 w-6 text-sage" />
                  <h2 className="text-xl text-text">{p.title}</h2>
                  <p className="text-sm text-muted leading-relaxed">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <Frame className="p-8 md:p-12 grid gap-8 md:grid-cols-[1fr_auto] items-center">
              <div className="space-y-3">
                <h2 className="text-2xl md:text-3xl text-text">Make your next leaked key a non-event.</h2>
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
      <Node icon={ServerStack01Icon} label="Your app" detail="stand-in credential + workload proof" />
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

function Arrow(): ReactNode {
  return <div className="ml-6 h-5 border-l border-dashed border-line-strong" aria-hidden />
}
