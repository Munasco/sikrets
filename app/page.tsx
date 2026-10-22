import Link from "next/link"
import type { ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Key01Icon, Plug01Icon, RefreshIcon, SquareLock02Icon, CommandLineIcon, UserGroupIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Frame } from "@/components/frame"
import { Wordmark } from "@/components/logo"

const tennantUrl = process.env.NEXT_PUBLIC_TENNANT_URL ?? "https://usetennant.com"

const pillars = [
  {
    icon: Key01Icon,
    title: "Provision access",
    body: "Give teammates and services exactly the secrets they need, per project and per environment. Nothing more.",
  },
  {
    icon: Plug01Icon,
    title: "Connect services",
    body: "Link GitHub, AWS, Stripe and more once. Every project sees its connections in one place.",
  },
  {
    icon: RefreshIcon,
    title: "Rotate credentials",
    body: "Replace a value and every version is tracked. Rotation is a save, not a scavenger hunt.",
  },
]

const secrets = [
  { key: "DATABASE_URL", meta: "aws · v4 · 2 hours ago" },
  { key: "STRIPE_SECRET_KEY", meta: "stripe · v2 · 3 days ago" },
  { key: "GITHUB_APP_PRIVATE_KEY", meta: "github · v1 · last week" },
  { key: "RESEND_API_KEY", meta: "custom · v3 · last month" },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-line">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Wordmark />
          <nav className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/projects">Open Sikrets</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="max-w-6xl mx-auto px-6 pt-20 pb-24 grid gap-16 lg:grid-cols-[1.1fr_1fr] items-center">
          <div className="space-y-8">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">Introducing Sikrets</p>
            <h1 className="text-4xl md:text-6xl leading-[1.05] text-text">
              A home for your projects&apos; secrets and connections.
            </h1>
            <p className="text-lg text-sage max-w-xl">
              Provision access, connect services, and rotate credentials—all in one place.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/sign-in">Get started</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#security">How it&apos;s secured</a>
              </Button>
            </div>
          </div>

          <Frame className="p-0">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <span className="text-text">acme-api</span>
              <div className="flex gap-1 text-xs">
                <span className="px-2 py-1 text-muted">development</span>
                <span className="px-2 py-1 text-muted">staging</span>
                <span className="px-2 py-1 border-b-2 border-text text-text">production</span>
              </div>
            </div>
            <div className="divide-y divide-line">
              {secrets.map((s) => (
                <div key={s.key} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm text-text truncate">{s.key}</p>
                    <p className="text-xs text-faint">{s.meta}</p>
                  </div>
                  <p className="font-mono text-sm text-label">••••••••••</p>
                </div>
              ))}
            </div>
          </Frame>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20 grid gap-px bg-line md:grid-cols-3 border border-line">
            {pillars.map((p) => (
              <div key={p.title} className="bg-ink p-8 space-y-4">
                <HugeiconsIcon icon={p.icon} className="h-6 w-6 text-sage" />
                <h2 className="text-xl text-text">{p.title}</h2>
                <p className="text-sm text-muted leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="security" className="border-t border-line scroll-mt-8">
          <div className="max-w-6xl mx-auto px-6 py-20 grid gap-12 lg:grid-cols-2">
            <div className="space-y-4">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-sage">Security</p>
              <h2 className="text-3xl md:text-4xl text-text">Encrypted before it leaves your browser.</h2>
              <p className="text-muted leading-relaxed">
                Your vault password never leaves your device. It unlocks a workspace key that encrypts every value with
                AES-256-GCM, so the server only ever stores ciphertext.
              </p>
            </div>
            <ul className="space-y-6">
              <Point icon={SquareLock02Icon} title="End-to-end encrypted">
                Values are encrypted and decrypted on your machine. Key names stay searchable; values don&apos;t.
              </Point>
              <Point icon={UserGroupIcon} title="Every change on the record">
                Creates, rotations and deletions land in an audit log for the workspace.
              </Point>
              <Point icon={CommandLineIcon} title="Works where you work">
                The Tennant CLI syncs infrastructure outputs into the same vault and injects them at runtime.
              </Point>
            </ul>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <Frame className="p-8 md:p-12 grid gap-8 md:grid-cols-[1fr_auto] items-center">
              <div className="space-y-4">
                <h2 className="text-2xl md:text-3xl text-text">No more <span className="font-mono">.env</span> files in Slack.</h2>
                <pre className="font-mono text-sm text-label bg-field border border-line px-4 py-3 overflow-x-auto">
                  <span className="text-faint">$ </span>tennant projects sync{"\n"}
                  <span className="text-faint">$ </span>tennant projects run bun dev
                </pre>
              </div>
              <Button size="lg" asChild>
                <Link href="/sign-in">Start with your Tennant account</Link>
              </Button>
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
            <a href="https://usetennant.com/terms" className="hover:text-text">Terms</a>
            <a href="https://usetennant.com/privacy" className="hover:text-text">Privacy</a>
          </div>
        </div>
      </footer>
    </div>
  )
}

function Point({ icon, title, children }: { icon: typeof Key01Icon; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <HugeiconsIcon icon={icon} className="h-5 w-5 text-sage shrink-0 mt-0.5" />
      <div>
        <p className="text-text">{title}</p>
        <p className="text-sm text-muted leading-relaxed">{children}</p>
      </div>
    </li>
  )
}
