import { HugeiconsIcon } from "@hugeicons/react"
import { SquareLock02Icon, Key01Icon, RefreshIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Frame } from "@/components/frame"
import { Wordmark } from "@/components/logo"
import { RotatingWord } from "@/components/rotating-word"
import { HeroDiagram } from "@/components/hero-diagram"

const tennantUrl = "https://usetennant.com"
const waitlistUrl = `${tennantUrl}/waitlist`
const demoUrl = "https://cal.com/munachi-ernest-eze/custom?duration=20"

const subjects = ["agent.", "app.", "MCP server.", "pipeline."]

const pillars = [
  { icon: Key01Icon, title: "Provision", body: "Sikrets creates each agent's keys, scoped to what it needs." },
  { icon: SquareLock02Icon, title: "Keep", body: "Encrypted on your device. We only ever hold ciphertext." },
  { icon: RefreshIcon, title: "Rotate", body: "Keys renew on schedule. Leaked ones expire on their own." },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Wordmark />
          <Button asChild>
            <a href={waitlistUrl}>Join the beta</a>
          </Button>
        </div>
      </header>

      <main className="flex-1">
        <section className="max-w-6xl mx-auto px-6 pt-24 md:pt-32 pb-24 text-center">
          <h1 className="mx-auto max-w-4xl text-4xl md:text-6xl leading-[1.05] text-text">
            Credential management for the agentic era.
          </h1>
          <p className="mt-6 text-xl md:text-2xl text-text-soft">
            Auto-provisioned, auto-rotated keys for every <RotatingWord words={subjects} />
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Button size="lg" asChild>
              <a href={waitlistUrl}>Join the beta</a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <a href={demoUrl}>Book a demo</a>
            </Button>
          </div>
          <Frame className="mt-20 md:mt-24 p-6 md:p-10">
            <HeroDiagram />
          </Frame>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-24 grid gap-12 md:grid-cols-3">
            {pillars.map((p) => (
              <div key={p.title} className="space-y-3">
                <HugeiconsIcon icon={p.icon} className="h-6 w-6 text-sage" />
                <h2 className="text-2xl text-text">{p.title}</h2>
                <p className="text-muted">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-24 text-center space-y-8">
            <div className="space-y-4">
              <h2 className="text-3xl md:text-4xl text-text">Stop handing raw keys to every tool you use.</h2>
              <p className="mx-auto max-w-xl text-muted">
                Coding agents, hosting platforms, CI—they&apos;re built to run your code, not guard your secrets. Give them
                scoped, rotating keys from Sikrets instead.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              <Button size="lg" asChild>
                <a href={waitlistUrl}>Join the beta</a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href={demoUrl}>Book a demo</a>
              </Button>
            </div>
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
