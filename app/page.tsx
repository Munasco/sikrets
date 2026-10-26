import Image from "next/image"
import { Accordion, Card, EmailForm, Headline, Mock, VaultDiagram } from "@/components/landing"
import { SikretsMark } from "@/components/logo"
import { site } from "@/lib/site"

const { tennantUrl, waitlistUrl, demoUrl } = site

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: site.name,
  url: site.url,
  description: site.description,
  applicationCategory: "SecurityApplication",
  operatingSystem: "macOS, Linux",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  publisher: { "@type": "Organization", name: "Tennant", url: tennantUrl },
}

const nav = [
  { label: "Product", href: "#product" },
  { label: "Use cases", href: "#use-cases" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

const providers = ["Upstash", "Anthropic", "AWS", "OpenAI", "Cloudflare", "Neon", "Resend", "Supabase"]

const security = [
  { q: "Encrypted on your device", a: "Keys are encrypted before they leave your machine. Sikrets only ever stores the encrypted copy." },
  { q: "Secrets never print", a: "Logs, errors and debug output show dots instead of keys." },
  { q: "A leaked .env opens nothing", a: "Projects, CI and hosting hold stand-ins, not real keys." },
  { q: "Each project sees only its own keys", a: "Access is limited per project, enforced by your cloud's IAM." },
]

const faq = [
  { q: "What is Sikrets?", a: "A place for your API keys. Your apps and agents use them without ever holding the real values." },
  { q: "What's a stand-in?", a: "A placeholder that sits in your .env, CI and hosting instead of the real key. On its own it opens nothing." },
  { q: "Is it free?", a: "Yes. Sikrets is open source, and there is a free cloud version." },
  { q: "How do agents use it?", a: "They run commands through sikrets run. The key is available while the command runs and is never shown to the agent." },
  { q: "Which services work?", a: "Over 3,000. Paste a key for any of them; Upstash, Anthropic and AWS are fully automatic." },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2">
            <SikretsMark size={18} />
            <span className="font-serif text-2xl tracking-tight">Sikrets</span>
          </a>
          <nav className="hidden items-center gap-8 text-sm text-neutral-300 md:flex">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="hover:text-white">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-4 text-sm">
            <a href={demoUrl} className="hidden text-neutral-300 hover:text-white sm:inline">
              Book a demo
            </a>
            <a href={waitlistUrl} className="rounded-full border border-white/25 px-4 py-1.5 hover:bg-white hover:text-black">
              Get started
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <Image src="/landing/hero-key.jpg" alt="A black security key resting on a concrete block" fill priority sizes="100vw" className="object-cover object-[70%_center]" />
          <div className="absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent md:via-black/30" />
          <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black to-transparent" />
          <div className="relative mx-auto flex min-h-[720px] max-w-6xl flex-col justify-center px-6 pb-40 pt-24">
            <h1 className="max-w-2xl font-serif text-6xl leading-[1] tracking-tight md:text-7xl">
              The security platform for the <em className="italic">agent era</em>
            </h1>
            <p className="mt-5 max-w-md text-lg text-neutral-300">Secure every API key your agents and apps use, without ever handing them over.</p>
            <div className="mt-8">
              <EmailForm action={waitlistUrl} cta="Get started" id="hero-email" />
            </div>
          </div>
          <div className="relative -mt-28 pb-14 text-center">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-10 gap-y-4 px-6">
              {providers.map((p) => (
                <span key={p} className="text-xl font-semibold tracking-tight text-neutral-500">
                  {p}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Product */}
        <section id="product" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-28">
          <Headline sub="Real keys stay in one vault. Everything else gets a placeholder.">How it works</Headline>
          <div className="mt-14 grid gap-4 md:grid-cols-2">
            <Card image="/landing/vault.jpg" alt="An open vault door with soft green light" title="The vault" body="Your keys live encrypted in one place." className="min-h-[24rem]" />
            <Card image="/landing/standin.jpg" alt="A steel key beside an identical glass key" title="Stand-ins" body="Your .env and CI hold a copy that opens nothing." className="min-h-[24rem]" />
            <Card image="/landing/rotate.jpg" alt="A key turning inside a ring of light" title="Rotation" body="Keys renew on a schedule. Nothing to redeploy." className="min-h-[26rem] md:col-span-2" imageClassName="object-[center_40%]" />
          </div>
        </section>

        {/* Use cases */}
        <section id="use-cases" className="mx-auto max-w-6xl scroll-mt-24 px-6 pb-28">
          <Headline sub="Whether an agent writes the code or you ship it.">Built for how you work</Headline>
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            <Card title="Working with agents" body="They use the key. They never see it.">
              <Mock title="terminal" hot={[0]} lines={["$ sikrets run -- claude", "  ANTHROPIC_API_KEY  ready"]} />
            </Card>
            <Card title="Deploying code" body="CI and hosting hold stand-ins, not real keys.">
              <Mock title=".env" lines={["ANTHROPIC_API_KEY=sk-sikrets-8f2a…", "UPSTASH_TOKEN=sk-sikrets-41c9…"]} />
            </Card>
            <Card title="Knowing what happened" body="See which key was used, and when.">
              <Mock title="sikrets activity" lines={["10:42  run     bun", "10:40  rotate  upstash", "10:31  add     anthropic"]} />
            </Card>
          </div>
        </section>

        {/* Safe changes */}
        <section className="mx-auto max-w-6xl px-6 pb-28">
          <Headline sub="Preview every change. Undo it if you need to.">No surprises</Headline>
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            <Card title="Dry run" body="See every change and its cost first.">
              <Mock title="--dry-run" lines={['+ Create upstash/redis "cache"', "+ Store 2 keys in the vault", "+ Write stand-ins to .env"]} />
            </Card>
            <Card title="Rollback" body="Undo an add, step by step.">
              <Mock title="sikrets rollback" lines={['- Forget "cache"', "- Remove stand-ins from .env", '- Delete upstash/redis "cache"']} />
            </Card>
            <Card title="Status" body="Every key, when it was last used, and when it rotates.">
              <Mock title="sikrets status" hot={[1]} lines={["NAME       STATE  ROTATE", "cache      live   in 28d", "anthropic  live   in 30d"]} />
            </Card>
          </div>
        </section>

        {/* Security */}
        <section id="security" className="mx-auto max-w-6xl scroll-mt-24 px-6 pb-28">
          <Headline sub="A leak, a log line or a curious agent never exposes a real key.">Secure by design</Headline>
          <div className="mt-14 grid items-center gap-10 md:grid-cols-2">
            <VaultDiagram />
            <Accordion items={security} />
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="mx-auto max-w-4xl scroll-mt-24 px-6 pb-28">
          <Headline align="left">
            Free to <em>start</em>
          </Headline>
          <div className="mt-12 grid gap-10 border-t border-white/10 pt-10 md:grid-cols-2">
            {[
              { name: "Cloud", price: "Free", cta: "Get started", primary: true, points: ["Hosted vault, nothing to set up", "Stand-ins and rotation", "Activity log"] },
              { name: "Open source", price: "Free", cta: "View on GitHub", primary: false, points: ["Run it on your own AWS", "CLI and SDK", "Every recipe"] },
            ].map((p) => (
              <div key={p.name}>
                <p className="text-sm text-neutral-400">{p.name}</p>
                <p className="mt-1 font-serif text-5xl">{p.price}</p>
                <a href={p.primary ? waitlistUrl : site.githubUrl} className={`mt-6 block rounded-full py-2.5 text-center text-sm ${p.primary ? "bg-white text-black hover:bg-neutral-200" : "border border-white/25 hover:bg-white/10"}`}>
                  {p.cta}
                </a>
                <ul className="mt-6 space-y-2.5 text-sm text-neutral-400">
                  {p.points.map((x) => (
                    <li key={x}>✓ {x}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto grid max-w-6xl scroll-mt-24 gap-12 px-6 pb-28 md:grid-cols-[1fr_1.5fr]">
          <div>
            <h2 className="font-serif text-5xl leading-[1.02]">Questions</h2>
            <p className="mt-4 text-sm text-neutral-400">
              Something else?{" "}
              <a href={demoUrl} className="text-white underline underline-offset-4">
                Get in touch
              </a>
              .
            </p>
          </div>
          <Accordion items={faq} defaultOpen={-1} />
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden bg-gradient-to-b from-black via-neutral-900 to-[#2a2b27]">
          <div className="mx-auto max-w-3xl px-6 py-32 text-center">
            <h2 className="font-serif text-5xl md:text-6xl">Secure your first key in minutes</h2>
            <div className="mt-9 flex justify-center">
              <EmailForm action={waitlistUrl} cta="Get started" id="cta-email" />
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-[#2a2b27]/40">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div className="flex items-center gap-2 self-start">
            <SikretsMark size={18} />
            <span className="font-serif text-2xl">Sikrets</span>
          </div>
          {[
            { h: "Product", l: [["The vault", "#product"], ["Use cases", "#use-cases"], ["Pricing", "#pricing"]] },
            { h: "Security", l: [["Secure by design", "#security"], ["FAQ", "#faq"]] },
            { h: "Company", l: [["Tennant", tennantUrl], ["Terms", `${tennantUrl}/terms`], ["Privacy", `${tennantUrl}/privacy`]] },
          ].map((c) => (
            <div key={c.h}>
              <p className="text-sm text-white">{c.h}</p>
              <ul className="mt-3 space-y-2 text-sm text-neutral-400">
                {c.l.map(([label, href]) => (
                  <li key={label}>
                    <a href={href} className="hover:text-white">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mx-auto flex max-w-6xl items-center justify-between border-t border-white/10 px-6 py-6 text-xs text-neutral-500">
          <span>
            A product of{" "}
            <a href={tennantUrl} className="text-neutral-300 hover:text-white">
              Tennant
            </a>
          </span>
          <span>© {new Date().getFullYear()} Tennant</span>
        </div>
      </footer>
    </div>
  )
}
