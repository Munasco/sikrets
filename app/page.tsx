import Image from "next/image"
import { HugeiconsIcon } from "@hugeicons/react"
import { Building03Icon, UserGroupIcon, UserIcon } from "@hugeicons/core-free-icons"
import { Accordion, Check, Container, GuardCard, Headline, HeroButton, PhotoCard, Pill } from "@/components/landing"
import { SikretsMark } from "@/components/logo"
import { Reveal } from "@/components/reveal"
import { site } from "@/lib/site"

const { tennantUrl, waitlistUrl, demoUrl, githubUrl } = site

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
  { label: "How it works", href: "#product" },
  { label: "For you", href: "#tiers" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

const providers = ["Upstash", "Anthropic", "AWS", "OpenAI", "Cloudflare", "Neon", "Resend", "Supabase"]

const tiers = [
  { who: "You", role: "Virtual security guard", icon: UserIcon },
  { who: "Your startup", role: "Autonomous security engineer", icon: UserGroupIcon },
  { who: "Your company", role: "Autonomous security team", icon: Building03Icon },
]

const security = ["Encrypted on your device", "Secrets never print", "A leaked .env opens nothing", "Each project sees only its own keys"]

const faq = [
  { q: "What is Sikrets?", a: "A security guard for your keys. Your apps and agents use them without ever holding the real values." },
  { q: "What's a stand-in?", a: "A placeholder that sits in your .env, CI and hosting instead of the real key. On its own it opens nothing." },
  { q: "Is it free?", a: "Yes. Sikrets is open source, and there is a free cloud version." },
  { q: "How do agents use it?", a: "They run commands through sikrets run. The key is available while the command runs and is never shown to the agent." },
  { q: "Which services work?", a: "Over 3,000. Paste a key for any of them; Upstash, Anthropic and AWS are fully automatic." },
]

const footerLinks = [
  { h: "Product", l: [["How it works", "#product"], ["Security", "#security"], ["Pricing", "#pricing"], ["FAQ", "#faq"]] },
  { h: "Open source", l: [["GitHub", githubUrl]] },
  { h: "Company", l: [["Tennant", tennantUrl], ["Terms", `${tennantUrl}/terms`], ["Privacy", `${tennantUrl}/privacy`]] },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper text-ink">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <header className="sticky top-0 z-40 bg-paper/90 backdrop-blur">
        <Container className="flex h-[72px] items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <SikretsMark size={20} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight">Sikrets</span>
          </a>
          <nav className="hidden items-center gap-8 font-mono text-[13px] text-ink-soft md:flex">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-ink">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2.5">
            <a href={demoUrl} className="hidden h-10 items-center rounded-lg border border-line bg-white px-3.5 font-serif text-[1.1rem] leading-none transition-colors hover:bg-cream sm:inline-flex">
              Book a demo
            </a>
            <Pill href={waitlistUrl} className="h-10 px-4 text-[1.1rem]">
              Get started
            </Pill>
          </div>
        </Container>
      </header>

      <main>
        {/* Hero */}
        <section className="px-2 sm:px-4 md:px-6">
          <div className="relative overflow-hidden rounded-2xl bg-black md:rounded-[1.75rem]">
            <div className="absolute inset-x-0 top-0 h-[400px] sm:h-[480px] md:inset-0 md:h-auto">
              <Image src="/landing/hero-key.jpg" alt="A black security key with a green light, resting on a concrete block" fill priority sizes="100vw" className="object-cover object-[68%_center]" />
            </div>
            <div className="absolute inset-x-0 top-0 h-[400px] bg-gradient-to-b from-transparent via-black/20 to-black sm:h-[480px] md:inset-0 md:h-auto md:bg-gradient-to-r md:from-black/85 md:via-black/45 md:to-transparent" />
            <Container className="relative flex min-h-[640px] flex-col justify-end gap-10 pb-6 pt-[300px] sm:pb-12 sm:pt-[380px] md:min-h-[720px] md:flex-row md:items-end md:justify-between md:gap-12 md:pb-16 md:pt-40">
              <div className="max-w-xl text-white">
                <h1 className="display text-balance text-[3.25rem] sm:text-7xl md:text-[5.5rem]">
                  Your virtual <em>security guard.</em>
                </h1>
                <p className="mt-5 text-[18px] text-white/75 md:text-xl">Like Grok, but for security. For you or your company.</p>
                <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <HeroButton href={waitlistUrl}>Get started</HeroButton>
                  <a href={demoUrl} className="font-serif text-[1.2rem] text-white/85 underline-offset-4 hover:text-white hover:underline">
                    Book a demo
                  </a>
                </div>
              </div>
              <GuardCard />
            </Container>
          </div>
        </section>

        {/* Works with */}
        <Container className="py-12 md:py-16">
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {providers.map((p) => (
              <span key={p} className="text-xl font-medium tracking-tight text-faint">
                {p}
              </span>
            ))}
          </div>
        </Container>

        {/* How it works */}
        <section id="product" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline sub="Real keys stay in one vault. Everything else gets a placeholder.">How it works</Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
              <Reveal>
                <PhotoCard image="/landing/vault.jpg" alt="An open vault door with soft green light" title="The vault" body="Your keys live encrypted in one place." />
              </Reveal>
              <Reveal delay={80}>
                <PhotoCard image="/landing/standin.jpg" alt="A steel key beside an identical glass key" title="Stand-ins" body="Your .env and CI hold a copy that opens nothing." />
              </Reveal>
              <Reveal delay={160}>
                <PhotoCard image="/landing/rotate.jpg" alt="A key turning inside a ring of light" title="Rotation" body="Keys renew on a schedule. Nothing to redeploy." />
              </Reveal>
            </div>
          </Container>
        </section>

        {/* Tiers */}
        <section id="tiers" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline sub="It starts with your keys.">One guard, sized to you</Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
              {tiers.map((t, i) => (
                <Reveal key={t.who} delay={i * 80}>
                  <div className="flex h-full flex-col rounded-2xl border border-line bg-cream p-6 md:p-8">
                    <span className="grid size-11 place-items-center rounded-full bg-white text-pine shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
                      <HugeiconsIcon icon={t.icon} size={20} strokeWidth={1.6} />
                    </span>
                    <p className="mt-10 font-mono text-[12px] uppercase tracking-[0.08em] text-muted md:mt-16">{t.who}</p>
                    <p className="display mt-2 text-[2rem] text-ink md:text-[2.25rem]">{t.role}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Security */}
        <section id="security" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline sub="A leak, a log line or a curious agent never exposes a real key.">Secure by design</Headline>
            </Reveal>
            <Reveal className="mt-12" delay={80}>
              <ul className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 md:grid-cols-4">
                {security.map((s) => (
                  <li key={s} className="flex items-start gap-3 bg-paper p-6 text-[17px] leading-snug text-ink md:min-h-36 md:flex-col md:gap-6">
                    <Check />
                    {s}
                  </li>
                ))}
              </ul>
            </Reveal>
          </Container>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline>
                Free to <em>start.</em>
              </Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2">
              {[
                { name: "Cloud", note: "Nothing to set up", href: waitlistUrl, cta: "Get started", variant: "primary" as const },
                { name: "Open source", note: "Run it on your own AWS", href: githubUrl, cta: "View on GitHub", variant: "outline" as const },
              ].map((p, i) => (
                <Reveal key={p.name} delay={i * 80}>
                  <div className="flex h-full flex-col rounded-2xl border border-line bg-cream p-6 md:p-8">
                    <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{p.name}</p>
                    <p className="display mt-4 text-5xl text-ink">Free</p>
                    <p className="mt-2 text-[15px] text-ink-soft">{p.note}</p>
                    <Pill href={p.href} variant={p.variant} className="mt-8 w-full sm:w-auto sm:self-start">
                      {p.cta}
                    </Pill>
                  </div>
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-24 py-16 md:py-24">
          <Container className="grid gap-10 md:grid-cols-[1fr_1.6fr] md:gap-12">
            <Reveal>
              <Headline>Questions</Headline>
            </Reveal>
            <Reveal delay={80}>
              <Accordion items={faq} defaultOpen={-1} />
            </Reveal>
          </Container>
        </section>

        {/* Closing */}
        <section className="px-2 pb-2 sm:px-4 md:px-6">
          <div className="relative overflow-hidden rounded-2xl bg-night px-5 py-24 text-center text-white md:rounded-[1.75rem] md:py-36">
            <Image src="/landing/rotate.jpg" alt="" fill sizes="100vw" className="object-cover opacity-35" />
            <Reveal className="relative">
              <h2 className="display mx-auto max-w-3xl text-balance text-[2.5rem] sm:text-5xl md:text-[3.75rem]">Secure your first key in minutes</h2>
              <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                <Pill href={waitlistUrl} variant="light">
                  Get started
                </Pill>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="bg-night text-white">
        <Container className="grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="flex items-center gap-2.5 self-start">
            <SikretsMark size={20} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight">Sikrets</span>
          </div>
          {footerLinks.map((c) => (
            <div key={c.h}>
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-white/50">{c.h}</p>
              <ul className="mt-4 space-y-3 font-mono text-[13px] text-white/80">
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
        </Container>
        <Container className="flex flex-col gap-2 border-t border-white/10 py-6 font-mono text-[11px] uppercase tracking-[0.08em] text-white/45 sm:flex-row sm:items-center sm:justify-between">
          <span>
            A product of{" "}
            <a href={tennantUrl} className="text-white/70 hover:text-white">
              Tennant
            </a>
          </span>
          <span>© {new Date().getFullYear()} Tennant</span>
        </Container>
      </footer>
    </div>
  )
}
