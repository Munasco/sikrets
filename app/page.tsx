import Image from "next/image"
import { Accordion, CardPhoto, Check, Container, Headline, HeroButton, MediaCard, Pill, ProductBlock } from "@/components/landing"
import { AgentAccessScene, ChatScene, GuardFeed, GuardScene, LeakScene, SceneBackdrop } from "@/components/scenes"
import { SikretsMark } from "@/components/logo"
import { Reveal } from "@/components/reveal"
import { site } from "@/lib/site"
import { cn } from "@/lib/utils"

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
  { label: "Trust", href: "#trust" },
  { label: "For you", href: "#tiers" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

/** Moments the guard steps in, keys and everything else. One line each. */
const uses = [
  "A key lands in a public repo.",
  "An attachment tries to open your keychain.",
  "Someone signs in to your email from a new country.",
  "An AI agent asks for more than its task needs.",
  "Your SIM moves to a phone you don't own.",
  "A payment doesn't look like you.",
]

/** The three things it guards, each with a live scene. */
const products = [
  {
    name: "Leaked keys",
    line: "Finds your API keys wherever they leak and replaces them before anyone can use them. Your apps keep running.",
    points: [
      ["Leak detection", "Watches public repos, logs and pastes for your keys."],
      ["Automatic rotation", "A leaked key is replaced in seconds. Nothing to redeploy."],
      ["No keys in your code", "Your .env, CI and hosting hold placeholders. The real key is attached on the way out."],
    ] as [string, string][],
    scene: <LeakScene />,
    photo: "/landing/tower.jpg",
  },
  {
    name: "Your devices and accounts",
    line: "Learns what normal looks like on your laptop, phone and accounts, and holds anything that isn't until you decide.",
    points: [
      ["Watches quietly", "Downloads, sign-ins, apps and payments. No rules to write."],
      ["Holds, then asks", "Approve on your phone or laptop, like a passkey."],
      ["Keeps the evidence", "Every hold comes with what happened and why."],
    ] as [string, string][],
    scene: <GuardScene />,
    photo: "/landing/cabin.jpg",
  },
  {
    name: "Your AI agents",
    line: "Claude, ChatGPT and Cursor get the access a task needs, for as long as it takes. They never see the key.",
    points: [
      ["Scoped access", "Each agent reaches only the services you allow."],
      ["Expires on its own", "Access ends with the task, or after an hour."],
      ["Works over MCP", "Connect any agent in one command."],
    ] as [string, string][],
    scene: <AgentAccessScene />,
    photo: "/landing/road.jpg",
  },
]

/** How it decides, from the blueprint: the model proposes, policy enforces. */
const rules = [
  ["The model proposes, policy decides", "It investigates and suggests. A fixed policy decides what runs."],
  ["Every permission expires", "Access is narrow, time-limited and revocable."],
  ["Each action has a reason and an undo", "Only you can see them."],
]

/** Plans. Prices are the founder's call; the paid tiers show availability until they are set. */
const plans = [
  { name: "Doorman", price: "$0", term: "forever", tag: "Non-commercial use", cta: { label: "Get started", href: waitlistUrl, variant: "primary" as const }, features: ["The agent on your devices and accounts", "Asks before it acts", "Automatic key rotation", "Up to 10 people in your circle"] },
  { name: "Warden", price: "Early access", term: "", tag: "Proactive protection", cta: { label: "Join the waitlist", href: waitlistUrl, variant: "outline" as const }, features: ["Everything in Doorman", "Holds anything unusual on its own", "Approve from your phone", "Guards the AI agents you run", "Hardware key as a second check"] },
  { name: "Citadel", price: "Custom", term: "", tag: "Money, wallets and recovery", cta: { label: "Talk to us", href: demoUrl, variant: "outline" as const }, features: ["Everything in Warden", "Covers bank accounts and wallets", "2-of-3 approval with an emergency contact", "48-hour hold after a SIM change", "Hardware vault"] },
]

/** Why it can be trusted with what it watches. */
const trust = [
  ["Confidential compute", "Runs in a sealed enclave. Neither we nor the cloud can see what it sees."],
  ["Uses keys, never reads them", "It can use, rotate or revoke a key. Nothing can read one, including us."],
  ["Thinks like an attacker", "Built on models that don't refuse security work."],
  ["Open source", "Read the code that guards you."],
]

const surfaces = ["GitHub", "Stripe", "OpenAI", "AWS", "Gmail", "1Password", "Claude", "iPhone"]

const tiers = [
  { who: "You", role: "Virtual security guard", image: "/landing/cabin.jpg", alt: "A small cabin with a lit window in a misty forest", cta: { label: "Get started", href: waitlistUrl } },
  { who: "Your startup", role: "Autonomous security engineer", image: "/landing/tower.jpg", alt: "A fire lookout tower above fog and golden larches", cta: { label: "Get started", href: waitlistUrl } },
  { who: "Your company", role: "Autonomous security team", image: "/landing/city.jpg", alt: "A city skyline over still water at dawn", cta: { label: "Book a demo", href: demoUrl } },
]

const faq = [
  { q: "What is Sikrets?", a: "An AI security agent for you and your company. It rotates leaked keys, holds what looks wrong and asks before anything that matters." },
  { q: "Can it see my data?", a: "Only inside a sealed enclave. Neither we nor the cloud provider can read what it sees." },
  { q: "What does it do without asking?", a: "Only what you allow. Each kind of action is off, ask, hold or act. Anything involving money always asks." },
  { q: "Does it work with my AI agents?", a: "Yes. Claude, ChatGPT, Cursor and others connect over MCP and get access for one task, never the secret itself." },
  { q: "What about companies?", a: "Per seat. One guard across every laptop, account and agent your team runs. Book a demo." },
]

const footerLinks = [
  { h: "Product", l: [["Product", "#product"], ["Trust", "#trust"], ["Pricing", "#pricing"], ["FAQ", "#faq"]] },
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
                An AI agent that rotates leaked keys, stops what looks wrong
                <br className="hidden sm:block" /> and asks before anything that matters.
              </p>
              <div className="mt-8">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
              </div>
              <GuardFeed className="mt-auto md:absolute md:bottom-10 md:right-10 md:mt-0" />
            </div>
          </div>
        </section>

        {/* Works with */}
        <Container className="py-12 md:py-16">
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3 sm:gap-x-10">
            {surfaces.map((p) => (
              <span key={p} className="text-lg font-medium tracking-tight text-faint sm:text-xl">
                {p}
              </span>
            ))}
          </div>
        </Container>

        {/* When it steps in */}
        <section className="py-16 md:py-24">
          <Container className="grid gap-10 md:grid-cols-[1fr_1.4fr] md:gap-16">
            <Reveal>
              <Headline eyebrow="When it steps in">
                It watches, so you don't have to. <b>You hear from it when it matters.</b>
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

        {/* Product: one block per thing it guards, each with a live scene. */}
        <section id="product" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Product">
                One guard for <b>your keys, your devices and your agents.</b>
              </Headline>
            </Reveal>
            <div className="mt-16 space-y-20 md:space-y-28">
              {products.map((p, i) => (
                <Reveal key={p.name}>
                  <ProductBlock
                    name={p.name}
                    line={p.line}
                    points={p.points}
                    flip={i % 2 === 1}
                    scene={
                      <SceneBackdrop src={p.photo} className="min-h-[22rem] md:min-h-[26rem]">
                        {p.scene}
                      </SceneBackdrop>
                    }
                  />
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* Ask it: the dark band, with the rules it acts under. */}
        <section id="security" className="scroll-mt-24 bg-forest py-20 text-white md:py-28">
          <Container>
            <Reveal className="grid items-center gap-12 md:grid-cols-[1fr_1.1fr] md:gap-16">
              <div>
                <h2 className="display text-balance text-[2.4rem] sm:text-5xl md:text-[3.4rem]">
                  Ask it anything.
                  <span className="block text-white/50">It checks, explains, and acts only within your rules.</span>
                </h2>
              </div>
              <ChatScene />
            </Reveal>
            <Reveal className="mt-16 grid gap-8 border-t border-white/10 pt-10 md:grid-cols-3" delay={80}>
              {rules.map(([t, b]) => (
                <div key={t}>
                  <p className="text-[16px] font-medium">{t}</p>
                  <p className="mt-1.5 text-[14px] leading-snug text-white/60">{b}</p>
                </div>
              ))}
            </Reveal>
          </Container>
        </section>

        {/* Trust: four cells in one bordered strip. */}
        <section id="trust" className="scroll-mt-24 py-16 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Trust">
                A guard sees everything. <b>So it can't be the weak spot.</b>
              </Headline>
            </Reveal>
            <Reveal className="mt-12 grid overflow-hidden rounded-2xl border border-line sm:grid-cols-2 lg:grid-cols-4" delay={80}>
              {trust.map(([t, b], i) => (
                <div key={t} className={cn("p-6 md:p-7", i > 0 && "border-t border-line sm:border-t-0", i % 2 === 1 && "sm:border-l", i >= 2 && "sm:border-t lg:border-t-0", i > 0 && "lg:border-l")}>
                  <p className="text-[16px] font-medium text-forest">{t}</p>
                  <p className="mt-1.5 text-[14px] leading-snug text-ink-soft">{b}</p>
                </div>
              ))}
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
                  <MediaCard media={<CardPhoto src={t.image} alt={t.alt} />} label={t.who} title={t.role} cta={t.cta} />
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
                <b>Free</b> to start. Pay for how much it does on its own.
              </Headline>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
              {plans.map((p, i) => (
                <Reveal key={p.name} delay={i * 80}>
                  <div className="flex h-full flex-col rounded-2xl bg-cream p-6 md:p-7">
                    <p className="font-mono text-[12px] uppercase tracking-[0.08em] text-muted">{p.name}</p>
                    <p className="display mt-4 text-[2.6rem] text-forest">
                      {p.price}
                      {p.term && <span className="ml-2 font-sans text-[15px] text-ink-soft">{p.term}</span>}
                    </p>
                    <p className="mt-1 text-[15px] text-ink-soft">{p.tag}</p>
                    <ul className="mt-6 space-y-2.5 text-[15px] text-ink">
                      {p.features.map((f) => (
                        <li key={f} className="flex items-start gap-2.5">
                          <Check />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <Pill href={p.cta.href} variant={p.cta.variant} className="mt-8 w-full sm:w-auto sm:self-start">
                      {p.cta.label}
                    </Pill>
                  </div>
                </Reveal>
              ))}
            </div>
            <p className="mt-6 text-[15px] text-ink-soft">
              Companies: per seat, guarding every laptop, account and agent your team runs.{" "}
              <a href={demoUrl} className="text-forest underline underline-offset-4">
                Book a demo
              </a>
              .
            </p>
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
              <h2 className="display mx-auto max-w-3xl text-balance text-[2.6rem] text-forest sm:text-5xl md:text-[4rem]">Put a guard on duty tonight.</h2>
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
