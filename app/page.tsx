import Image from "next/image"
import { Accordion, AgentArt, CardPhoto, Check, Container, GuardCard, Headline, HeroButton, MediaCard, Pill, RotateArt, StandInArt, VaultArt } from "@/components/landing"
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
  { label: "Product", href: "#product" },
  { label: "Features", href: "#features" },
  { label: "For you", href: "#tiers" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

/** What people reach for Sikrets to do. One line each; no claim is repeated elsewhere on the page. */
const uses = [
  "Keep keys out of .env files and commits.",
  "Give AI agents API access without giving them the key.",
  "Rotate a leaked key in minutes, with nothing to redeploy.",
  "Find leaked credentials in code and repos.",
  "Grant access for an hour. It expires on its own.",
  "Use the cloud, or self-host on your own AWS.",
]

const products = [
  { art: <VaultArt />, title: "Vault", body: "Store a key once. It is encrypted on your device and never printed to a terminal or log." },
  { art: <StandInArt />, title: "Stand-ins", body: "Your .env, CI and hosting hold a placeholder. The real key is attached only when a request leaves for the provider." },
  { art: <RotateArt />, title: "Rotation", body: "Rotate on a schedule, or right after a leak. Running apps keep working." },
  { art: <AgentArt />, title: "Security agent", body: "Paste code or a repo URL. It finds leaked credentials and walks you through rotating them." },
]

const features = [
  ["Time-limited sessions", "An agent gets a key for one command or one hour, then it is revoked."],
  ["3,000+ services", "Add a key for any of them with one command."],
  ["MCP server", "Claude Code, Cursor and any MCP client, with no key in the context window."],
  ["Activity log", "Who used which key, when and from where."],
  ["Rollback", "Restore a project's keys to an earlier state."],
  ["Per-project scope", "A project can only read its own keys."],
  ["Secure enclave", "The security agent runs in AWS Nitro Enclaves. The host cannot read its memory."],
  ["Open source", "Source on GitHub. Audit it before you trust it."],
]

const providers = ["Upstash", "Anthropic", "AWS", "OpenAI", "Cloudflare", "Neon", "Resend", "Supabase"]

const tiers = [
  { who: "You", role: "Virtual security guard", image: "/landing/cabin.jpg", alt: "A small cabin with a lit window in a misty forest" },
  { who: "Your startup", role: "Autonomous security engineer", image: "/landing/tower.jpg", alt: "A fire lookout tower above fog and golden larches" },
  { who: "Your company", role: "Autonomous security team", image: "/landing/city.jpg", alt: "A city skyline over still water at dawn" },
]

const faq = [
  { q: "What is Sikrets?", a: "A security agent you can trust with your keys. It starts with keys and grows into a guard for you and your company." },
  { q: "How do agents use it?", a: "sikrets session run gives an agent a key for as long as the command runs. The agent never sees the value." },
  { q: "Can I self-host?", a: "Yes. The whole thing runs on your own AWS account." },
  { q: "Is it free?", a: "Yes. Open source, with a free cloud version." },
]

const footerLinks = [
  { h: "Product", l: [["Product", "#product"], ["Features", "#features"], ["Pricing", "#pricing"], ["FAQ", "#faq"]] },
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
            <SikretsMark size={22} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight text-forest">Sikrets</span>
          </a>
          <nav className="hidden items-center gap-7 text-[14px] font-medium text-ink-soft md:flex">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-ink">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2.5">
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
            <Image src="/landing/hero.jpg" alt="A lighthouse on a misty headland under a pale dawn sky" fill priority sizes="100vw" className="object-cover object-[48%_center]" />
            <div className="relative flex min-h-[780px] flex-col items-center px-5 pb-6 pt-20 text-center sm:min-h-[820px] md:min-h-[max(760px,calc(100svh-96px))] md:pb-10 md:pt-32">
              <h1 className="display text-balance text-[3rem] text-forest sm:text-6xl md:text-[5.2rem]">Your virtual security guard.</h1>
              <p className="mt-6 max-w-lg text-[16px] leading-snug text-[#3d4540] md:text-[18px]">
                The AI agent you can paste keys into.
                <br />
                Like Grokbot, but for security. For you and your company.
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

        {/* What it's for */}
        <section className="py-16 md:py-24">
          <Container className="grid gap-10 md:grid-cols-[1fr_1.4fr] md:gap-16">
            <Reveal>
              <Headline eyebrow="When to use it">
                Keys your apps and agents use <b>without ever holding them.</b>
              </Headline>
            </Reveal>
            <Reveal delay={80}>
              <ul className="divide-y divide-line border-y border-line">
                {uses.map((u) => (
                  <li key={u} className="flex items-start gap-3 py-4 text-[17px] text-ink">
                    <Check />
                    {u}
                  </li>
                ))}
              </ul>
            </Reveal>
          </Container>
        </section>

        {/* Product */}
        <section id="product" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Product">
                Store a key once. <b>Every app and agent uses it from there.</b>
              </Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {products.map((c, i) => (
                <Reveal key={c.title} delay={i * 80}>
                  <MediaCard media={c.art} title={c.title} body={c.body} />
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Features">
                <b>The full toolkit,</b> free and open source.
              </Headline>
            </Reveal>
            <Reveal className="mt-12" delay={80}>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {features.map(([t, b]) => (
                  <li key={t} className="rounded-2xl bg-cream p-6 md:min-h-36">
                    <p className="text-[16px] font-medium text-forest">{t}</p>
                    <p className="mt-1.5 text-[14px] leading-snug text-ink-soft">{b}</p>
                  </li>
                ))}
              </ul>
            </Reveal>
          </Container>
        </section>

        {/* Tiers */}
        <section id="tiers" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Who it's for">
                <b>One guard,</b> sized to you.
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
              <h2 className="display mx-auto max-w-3xl text-balance text-[2.6rem] text-forest sm:text-5xl md:text-[4rem]">Store your first key in a minute.</h2>
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
            <SikretsMark size={22} />
            <span className="font-serif text-[1.65rem] leading-none tracking-tight">Sikrets</span>
          </div>
          {footerLinks.map((c) => (
            <div key={c.h}>
              <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-white/50">{c.h}</p>
              <ul className="mt-4 space-y-3 text-[14px] text-white/80">
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
