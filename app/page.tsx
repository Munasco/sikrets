import Image from "next/image"
import { Accordion, CardPhoto, Check, Container, GuardCard, Headline, HeroButton, MediaCard, Pill, RotateArt, StandInArt, VaultArt } from "@/components/landing"
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
  { who: "You", role: "Virtual security guard", image: "/landing/cabin.jpg", alt: "A small cabin with a lit window in a misty forest" },
  { who: "Your startup", role: "Autonomous security engineer", image: "/landing/tower.jpg", alt: "A fire lookout tower above fog and golden larches" },
  { who: "Your company", role: "Autonomous security team", image: "/landing/city.jpg", alt: "A city skyline over still water at dawn" },
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

      <header className="sticky top-0 z-40 bg-paper/95 backdrop-blur">
        <Container className="flex h-[72px] items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <SikretsMark size={20} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight text-forest">Sikrets</span>
          </a>
          <nav className="hidden items-center gap-8 font-mono text-[13px] text-ink-soft md:flex">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-ink">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2.5">
            <a href={demoUrl} className="inline-flex h-10 items-center rounded-md border border-line bg-white px-3 font-serif text-[1.05rem] leading-none text-forest transition-colors hover:bg-cream sm:px-3.5 sm:text-[1.1rem]">
              Book a demo
            </a>
            <Pill href={waitlistUrl} className="h-10 rounded-md px-4 text-[1.1rem]">
              Get started
            </Pill>
          </div>
        </Container>
      </header>

      <main>
        {/* Hero: a tall pastel photo in a rounded card, headline centred over the sky. */}
        <section className="px-3 pt-1 sm:px-5 md:px-9">
          <div className="relative overflow-hidden rounded-2xl bg-sand md:rounded-[20px]">
            <Image src="/landing/hero.jpg" alt="A lighthouse on a misty headland under a pale dawn sky" fill priority sizes="100vw" className="object-cover object-[48%_center]" />
            <div className="relative flex min-h-[780px] flex-col items-center px-5 pb-6 pt-20 text-center sm:min-h-[820px] md:min-h-[max(760px,calc(100svh-96px))] md:pb-10 md:pt-32">
              <h1 className="display text-balance text-[3.3rem] text-forest sm:text-7xl md:text-[5.6rem]">Your virtual security guard.</h1>
              <p className="mt-6 max-w-md text-[17px] leading-snug text-[#3d4540] md:text-[19px]">
                Like Grok, but for security.
                <br />
                For you or your company.
              </p>
              <div className="mt-8">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
              </div>
              <GuardCard className="mt-auto md:absolute md:bottom-10 md:right-10 md:mt-0" />
            </div>
          </div>
        </section>

        {/* Works with */}
        <Container className="py-12 md:py-16">
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3 sm:gap-x-10">
            {providers.map((p) => (
              <span key={p} className="text-lg font-medium tracking-tight text-faint sm:text-xl">
                {p}
              </span>
            ))}
          </div>
        </Container>

        {/* How it works */}
        <section id="product" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="How it works">
                Real keys stay in <b>one vault.</b> Everything else gets <b>a placeholder.</b>
              </Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { art: <VaultArt />, title: "The vault", body: "Your keys live encrypted in one place." },
                { art: <StandInArt />, title: "Stand-ins", body: "Your .env and CI hold a copy that opens nothing." },
                { art: <RotateArt />, title: "Rotation", body: "Keys renew on a schedule. Nothing to redeploy." },
              ].map((c, i) => (
                <Reveal key={c.title} delay={i * 80}>
                  <MediaCard media={c.art} title={c.title} body={c.body} />
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Tiers */}
        <section id="tiers" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="For you">
                <b>One guard, sized to you.</b> It starts with your keys.
              </Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
              {tiers.map((t, i) => (
                <Reveal key={t.who} delay={i * 80}>
                  <MediaCard media={<CardPhoto src={t.image} alt={t.alt} />} label={t.who} title={t.role} />
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Security */}
        <section id="security" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Security">
                <b>Secure by design.</b> A leak, a log line or a curious agent never exposes a real key.
              </Headline>
            </Reveal>
            <Reveal className="mt-12" delay={80}>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
                {security.map((s) => (
                  <li key={s} className="flex items-start gap-3 rounded-2xl bg-cream p-6 text-[17px] leading-snug text-forest md:min-h-40 md:flex-col md:justify-between md:gap-6">
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
              <Headline eyebrow="Pricing">
                <b>Free</b> to start.
              </Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2">
              {[
                { name: "Cloud", note: "Nothing to set up", href: waitlistUrl, cta: "Get started", variant: "primary" as const },
                { name: "Open source", note: "Run it on your own AWS", href: githubUrl, cta: "View on GitHub", variant: "outline" as const },
              ].map((p, i) => (
                <Reveal key={p.name} delay={i * 80}>
                  <div className="flex h-full flex-col rounded-2xl bg-cream p-6 md:p-8">
                    <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{p.name}</p>
                    <p className="display mt-4 text-5xl text-forest">Free</p>
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
              <Headline eyebrow="FAQ">
                <b>Questions</b>
              </Headline>
            </Reveal>
            <Reveal delay={80}>
              <Accordion items={faq} defaultOpen={-1} />
            </Reveal>
          </Container>
        </section>

        {/* Closing: the road photo in a rounded card, headline centred over the sky like the hero. */}
        <section className="px-3 pb-3 pt-8 sm:px-5 md:px-9 md:pb-9">
          <div className="relative overflow-hidden rounded-2xl bg-sand md:rounded-[20px]">
            <Image src="/landing/road.jpg" alt="A road winding through an autumn forest with fog in the valleys" fill sizes="100vw" className="object-cover object-[60%_center]" />
            <Reveal className="relative flex min-h-[560px] flex-col items-center px-5 pt-16 text-center md:min-h-[680px] md:pt-24">
              <h2 className="display mx-auto max-w-3xl text-balance text-[2.6rem] text-forest sm:text-5xl md:text-[4rem]">Secure your first key in minutes</h2>
              <div className="mt-8">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="bg-forest text-white">
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
