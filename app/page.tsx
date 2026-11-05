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
  offers: { "@type": "AggregateOffer", lowPrice: "20", priceCurrency: "USD" },
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

const plans = [
  { name: "Doorman", who: "For you", price: "$20", per: "/ month", note: "A guard for your keys, devices and agents.", href: waitlistUrl, cta: "Get started" },
  { name: "Night's Watch", who: "For your startup", price: "$20", per: "/ seat / month", note: "Every person, and every agent they run.", href: waitlistUrl, cta: "Get started", featured: true },
  { name: "Fort Knox", who: "For your company", price: "Custom", per: "", note: "A dedicated guard in its own enclave.", href: demoUrl, cta: "Book a demo" },
]

const security = ["Encrypted on your device", "Secrets never print", "A leaked .env opens nothing", "Each project sees only its own keys"]

const faq = [
  { q: "What is Sikrets?", a: "A security guard for your keys. Your apps and agents use them without ever holding the real values." },
  { q: "What's a stand-in?", a: "A placeholder that sits in your .env, CI and hosting instead of the real key. On its own it opens nothing." },
  { q: "Is it open source?", a: "The vault is. Run it in your own cloud, or let us host it. The 24/7 guard comes with every plan." },
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
        <Container className="flex h-[72px] items-center justify-between lg:grid lg:grid-cols-[1fr_auto_1fr]">
          <a href="/" className="flex items-center gap-2.5">
            <SikretsMark size={20} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight text-forest">Sikrets</span>
          </a>
          <nav className="hidden items-center gap-8 text-[14px] font-medium text-ink-soft lg:flex">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-ink">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2.5 lg:justify-self-end">
            <a href={demoUrl} className="hidden h-10 items-center rounded-full border border-line bg-white px-4 text-[14px] font-medium leading-none text-forest transition-colors hover:bg-cream sm:inline-flex">
              Book a demo
            </a>
            <Pill href={waitlistUrl} className="h-10 px-4 text-[14px]">
              Get started
            </Pill>
          </div>
        </Container>
      </header>

      <main>
        {/* Hero: a tall pastel photo in a rounded card, headline centred over the sky. */}
        <section className="px-3 pt-1 sm:px-5 md:px-9">
          <div className="relative overflow-hidden rounded-2xl bg-sand md:rounded-[20px]">
            <Image src="/landing/hero.jpg" alt="A lighthouse on a misty headland under a pale dawn sky" fill priority sizes="(max-width: 767px) 1300px, 100vw" className="object-cover object-[48%_center]" />
            <div className="relative flex min-h-[620px] flex-col items-center px-5 pb-6 pt-16 text-center sm:min-h-[720px] md:min-h-[max(760px,calc(100svh-96px))] md:pb-10 md:pt-32">
              <h1 className="display text-balance text-[3.3rem] text-forest sm:text-7xl md:text-[5.6rem]">Your virtual security guard.</h1>
              <p className="mt-6 max-w-xl text-balance text-[17px] leading-snug text-ink-soft md:text-[19px]">
                The AI agent you can paste keys into.
                <br className="hidden sm:block" />
                Like Grokbot, but for security. For you and your company.
              </p>
              <div className="mt-8">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
              </div>
              <GuardCard className="hidden md:absolute md:bottom-10 md:right-10 md:block" />
            </div>
          </div>
          <div className="relative z-10 -mt-12 px-4 md:hidden">
            <GuardCard className="mx-auto" />
          </div>
        </section>

        {/* Works with */}
        <Container className="pt-10 pb-4 md:pt-12 md:pb-6">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 sm:gap-x-10">
            {providers.map((p) => (
              <span key={p} className="text-[15px] font-medium tracking-tight text-muted sm:text-lg">
                {p}
              </span>
            ))}
          </div>
        </Container>

        {/* How it works */}
        <section id="product" className="scroll-mt-24 py-14 md:py-20">
          <Container>
            <Reveal>
              <Headline eyebrow="How it works">
                Real keys stay in <b>one vault.</b> Everything else gets <b>a placeholder.</b>
              </Headline>
            </Reveal>
            <div className="mt-8 grid md:mt-10 grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { art: <VaultArt />, title: "The vault", body: "Your keys live encrypted in one place." },
                { art: <StandInArt />, title: "Stand-ins", body: "Your .env and CI hold a copy that opens nothing." },
                { art: <RotateArt />, title: "Rotation", body: "Keys renew on a schedule. Nothing to redeploy." },
              ].map((c, i) => (
                <Reveal key={c.title} delay={i * 80}>
                  <MediaCard media={c.art} title={c.title} body={c.body} wide />
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Tiers */}
        <section id="tiers" className="scroll-mt-24 py-14 md:py-20">
          <Container>
            <Reveal>
              <Headline eyebrow="For you">
                <b>One guard, sized to you.</b> It starts with your keys.
              </Headline>
            </Reveal>
            <div className="mt-8 grid md:mt-10 grid-cols-1 gap-4 md:grid-cols-3">
              {tiers.map((t, i) => (
                <Reveal key={t.who} delay={i * 80}>
                  <MediaCard media={<CardPhoto src={t.image} alt={t.alt} />} label={t.who} title={t.role} />
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Security */}
        <section id="security" className="scroll-mt-24 py-14 md:py-20">
          <Container>
            <Reveal>
              <Headline eyebrow="Security">
                <b>Secure by design.</b> A leak, a log line or a curious agent never exposes a real key.
              </Headline>
            </Reveal>
            <Reveal className="mt-8 md:mt-10" delay={80}>
              <ul className="grid grid-cols-1 divide-y divide-forest/10 rounded-2xl bg-cream sm:grid-cols-2 sm:gap-4 sm:divide-y-0 sm:bg-transparent md:grid-cols-4">
                {security.map((s) => (
                  <li key={s} className="flex items-center gap-4 px-5 py-4 text-pretty text-[17px] leading-snug text-forest sm:rounded-2xl sm:bg-cream sm:p-6 md:flex-col md:items-start md:gap-5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-pine/10">
                      <Check />
                    </span>
                    {s}
                  </li>
                ))}
              </ul>
            </Reveal>
          </Container>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-24 py-14 md:py-20">
          <Container>
            <Reveal>
              <Headline eyebrow="Pricing">
                <b>Pick your guard.</b> Every plan watches around the clock.
              </Headline>
            </Reveal>
            <div className="mt-8 grid grid-cols-1 gap-4 md:mt-10 md:grid-cols-3">
              {plans.map((p, i) => (
                <Reveal key={p.name} delay={i * 80}>
                  <div className={p.featured ? "flex h-full flex-col rounded-2xl bg-[linear-gradient(180deg,#eef1f1,#f6eee8)] p-6 shadow-[0_12px_32px_-12px_rgba(40,50,45,0.12)] ring-1 ring-pine/20 md:p-8" : "flex h-full flex-col rounded-2xl bg-cream p-6 md:p-8"}>
                    <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{p.who}</p>
                    <h3 className="display mt-3 text-[2rem] text-forest">{p.name}</h3>
                    <p className="mt-4 flex items-baseline gap-1.5">
                      <span className="display text-5xl text-forest">{p.price}</span>
                      {p.per && <span className="text-[15px] text-ink-soft">{p.per}</span>}
                    </p>
                    <p className="mt-3 mb-8 text-pretty text-[15px] text-ink-soft">{p.note}</p>
                    <Pill href={p.href} variant={p.featured ? "primary" : "outline"} className="mt-auto w-full sm:w-auto sm:self-start">
                      {p.cta}
                    </Pill>
                  </div>
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-24 py-14 md:py-20">
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
            <Image src="/landing/road.jpg" alt="A road winding through an autumn forest with fog in the valleys" fill sizes="(max-width: 767px) 1300px, 100vw" className="object-cover object-[60%_center]" />
            <Reveal className="relative flex min-h-[560px] flex-col items-center px-5 pt-16 text-center md:min-h-[680px] md:pt-24">
              <h2 className="display mx-auto max-w-3xl text-balance text-[2.6rem] text-forest sm:text-5xl md:text-[4rem]">Secure your first key in minutes.</h2>
              <div className="mt-8">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="bg-forest text-white">
        <Container className="grid grid-cols-3 gap-6 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:gap-12 md:py-16">
          <div className="col-span-3 flex items-center gap-2.5 self-start md:col-span-1">
            <SikretsMark size={20} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight">Sikrets</span>
          </div>
          {footerLinks.map((c) => (
            <div key={c.h}>
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-white/60">{c.h}</p>
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
        <Container>
          <div className="flex flex-col gap-2 border-t border-white/10 py-6 font-mono text-[11px] uppercase tracking-[0.08em] text-white/60 sm:flex-row sm:items-center sm:justify-between">
          <span>
            A product of{" "}
            <a href={tennantUrl} className="text-white/70 hover:text-white">
              Tennant
            </a>
          </span>
          <span>© {new Date().getFullYear()} Tennant</span>
          </div>
        </Container>
      </footer>
    </div>
  )
}
