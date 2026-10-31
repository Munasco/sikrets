import { Accordion, Card, Check, Chip, Container, Eyebrow, GrantCard, Headline, HeroButton, Kw, LedgerMock, Pill, Stat, Terminal } from "@/components/landing"
import { SikretsMark } from "@/components/logo"
import { PathToggle } from "@/components/path-toggle"
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
  { label: "The case", href: "#case" },
  { label: "Developers", href: "#developers" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

const providers = ["Upstash", "Anthropic", "AWS", "OpenAI", "Cloudflare", "Neon", "Resend", "Supabase"]

const faq = [
  { q: "What is Sikrets?", a: "A security agent for people and AI agents. It keeps your credentials in custody, hands out time-limited access instead of standing access, revokes it, and keeps signed evidence of every decision." },
  { q: "What does the scan look at?", a: "An access graph: who and what can reach which resource, and through which standing access. It sees names and structure, never secret values." },
  { q: "What's a stand-in?", a: "A placeholder that sits in your .env, CI and hosting instead of the real key. On its own it opens nothing." },
  { q: "How do agents use it?", a: "Through sikrets run, the SDK, or the MCP server. The key is available to the work, not shown to the agent." },
  { q: "Is it free?", a: "The CLI, SDK and MCP server are open source. There is a free hosted plan; Team and Enterprise are coming." },
]

const footerLinks = [
  { h: "Product", l: [["How it works", "#product"], ["The case", "#case"], ["Pricing", "#pricing"], ["FAQ", "#faq"]] },
  { h: "Developers", l: [["GitHub", githubUrl], ["CLI", `${githubUrl}/tree/main/packages/cli`], ["SDK", `${githubUrl}/tree/main/packages/sdk`]] },
  { h: "Company", l: [["Tennant", tennantUrl], ["Terms", `${tennantUrl}/terms`], ["Privacy", `${tennantUrl}/privacy`]] },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
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
            <a href={githubUrl} className="hidden h-10 items-center rounded-lg border border-line bg-white px-3.5 font-serif text-[1.1rem] leading-none transition-colors hover:bg-cream sm:inline-flex">
              GitHub
            </a>
            <Pill href={waitlistUrl} className="h-10 px-4 text-[1.1rem]">
              Get started
            </Pill>
            <details className="relative md:hidden">
              <summary aria-label="Menu" className="grid size-10 cursor-pointer list-none place-items-center rounded-lg [&::-webkit-details-marker]:hidden">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M3 7h18M3 12h18M3 17h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </summary>
              <nav className="absolute right-0 top-12 flex w-56 flex-col rounded-xl border border-line bg-white p-2 font-mono text-[13px] shadow-xl shadow-black/5">
                {nav.map((n) => (
                  <a key={n.href} href={n.href} className="rounded-lg px-3 py-2.5 text-ink-soft hover:bg-cream hover:text-ink">
                    {n.label}
                  </a>
                ))}
                <a href={githubUrl} className="rounded-lg px-3 py-2.5 text-ink-soft hover:bg-cream hover:text-ink">
                  GitHub
                </a>
              </nav>
            </details>
          </div>
        </Container>
      </header>

      <main>
        {/* Hero */}
        <section className="px-2 sm:px-4 md:px-6">
          <div className="dusk grain relative overflow-hidden rounded-2xl md:rounded-[1.75rem]">
            <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-5 pt-20 text-center sm:pt-24 md:pt-32">
              <h1 className="display text-[2.75rem] text-pine sm:text-6xl md:text-[5rem] lg:text-[5.5rem]">
                Find the attack path <br className="hidden sm:block" />
                before <em>the attacker does.</em>
              </h1>
              <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink md:text-lg">
                Credentials in custody. Time-limited access for people and agents. Signed evidence of every decision.
              </p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
                <a href={demoUrl} className="font-serif text-[1.2rem] text-ink underline-offset-4 hover:underline">
                  Book a demo
                </a>
              </div>
            </div>
            <div className="relative z-10 mx-auto mt-14 max-w-3xl px-3 sm:px-6 md:mt-20">
              <Terminal title="sikrets-auto scan" className="rounded-b-none border-b-0 shadow-[0_-20px_60px_rgba(20,30,25,0.18)]">
                <span className="text-muted">$</span> sikrets-auto scan graph.json{"\n"}
                <span className="text-rust">✗</span> 2 of 6 entry points can reach a critical action through standing access alone.{"\n\n"}
                <span className="font-medium text-rust">CRITICAL</span>  devops-laptop → withdrawal-service → hot-wallet-signer → 11 critical resources <span className="text-muted">(transfer, sign)</span>
                {"\n"}
                {"          "}
                <span className="text-pine">fix:</span> require a time-limited grant for hot-wallet-signer → 11 critical resources,{"\n"}
                {"               "}and for devops-laptop → withdrawal-service
              </Terminal>
            </div>
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

        {/* The case */}
        <section id="case" className="scroll-mt-24 py-20 md:py-32">
          <Container>
            <Reveal>
              <Headline eyebrow="29 October 2026 · $6.36B" sub="A compromised DevOps laptop reached the container that could ask the signer for withdrawals. Standing access did the rest.">
                No key was stolen. <em>A trusted machine was allowed to ask.</em>
              </Headline>
            </Reveal>
            <Reveal className="mt-14" delay={100}>
              <PathToggle />
            </Reveal>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { v: "$6.36B", l: "Left hot wallets on ten chains, most of it within about twenty minutes." },
                { v: "0", l: "Private keys leaked. The attacker only needed a machine that was allowed to ask." },
                { v: "$0", l: "Lost in the replay once standing access is replaced by grants." },
              ].map((s, i) => (
                <Reveal key={s.v} delay={i * 80}>
                  <div className="rounded-2xl border border-line bg-cream p-6">
                    <p className="display text-5xl text-ink">{s.v}</p>
                    <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{s.l}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <p className="mt-6 font-mono text-[11px] text-muted">Scenario built from public reporting (TRM Labs, Binance). Internal architecture is illustrative. Not a claim about what would have happened.</p>
          </Container>
        </section>

        {/* How it works */}
        <section id="product" className="scroll-mt-24 py-20 md:py-32">
          <Container>
            <Reveal>
              <Headline eyebrow="Custody · Grants · Evidence" sub="Real keys stay in one place. Everything else gets a grant that ends, and a record that can't be edited.">
                Standing access <em>becomes a grant.</em>
              </Headline>
            </Reveal>
            <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Reveal>
                <Card title="Custody" body="Keys live in the vault. Projects, CI and agents hold stand-ins." className="h-full">
                  <Terminal title=".env">
                    ANTHROPIC_API_KEY=<span className="text-teal">sk-sikrets-8f2a…</span>
                    {"\n"}UPSTASH_TOKEN=<span className="text-teal">sk-sikrets-41c9…</span>
                    {"\n\n"}
                    <span className="text-muted">$</span> sikrets run -- bun dev{"\n"}
                    <span className="text-muted">  2 keys resolved for this run only</span>
                  </Terminal>
                </Card>
              </Reveal>
              <Reveal delay={80}>
                <Card title="Time-limited access" body="A grant names who, what and for how long. Then it ends." className="h-full">
                  <GrantCard />
                </Card>
              </Reveal>
              <Reveal>
                <Card title="Policy, not judgement" body="A deterministic gate in front of every consequential action. Models explain and propose; they never decide." className="h-full">
                  <div className="rounded-xl border border-line bg-white px-4 py-4 leading-7 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                    <Kw>WHEN </Kw>
                    <Chip color="tan">principal</Chip> <Kw>is</Kw> <Chip color="ink">withdrawal-service</Chip> <Kw>AND</Kw> <Chip color="tan">resource</Chip> <Kw>is</Kw> <Chip color="plum">hot-wallet-signer</Chip>
                    <br />
                    <Kw>THEN </Kw>
                    <Chip color="pine">require grant</Chip> <Kw>of</Kw> <Chip color="teal">45 min</Chip> <Kw>AND</Kw> <Chip color="rust">deny</Chip> <Chip color="moss">delegate</Chip> <Kw>always</Kw>
                  </div>
                </Card>
              </Reveal>
              <Reveal delay={80}>
                <Card title="Evidence" body="Every decision is appended to a hash-chained ledger with signed checkpoints." className="h-full">
                  <LedgerMock />
                </Card>
              </Reveal>
            </div>
          </Container>
        </section>

        {/* Developers */}
        <section id="developers" className="scroll-mt-24 py-20 md:py-32">
          <Container>
            <Reveal>
              <Headline eyebrow="Ships today" sub="Open source. The agent gets the work done; the key stays out of its context.">
                CLI, SDK <em>and MCP.</em>
              </Headline>
            </Reveal>
            <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
              <Reveal>
                <Card title="CLI" body="Run anything with its keys. Built with Bun." className="h-full">
                  <Terminal title="terminal" size="sm">
                    <span className="text-muted">$</span> sikrets run -- claude{"\n"}
                    <span className="text-muted">  ANTHROPIC_API_KEY  ready</span>
                    {"\n\n"}
                    <span className="text-muted">$</span> sikrets status{"\n"}
                    <span className="text-muted">  NAME       STATE  ROTATE</span>
                    {"\n"}  anthropic  <span className="text-pine">live</span>   in 30d
                  </Terminal>
                </Card>
              </Reveal>
              <Reveal delay={80}>
                <Card title="SDK" body="Ask for the real value at runtime. Stand-ins never come back." className="h-full">
                  <Terminal title="app.ts" size="sm">
                    <span className="text-plum">import</span> {"{ sikrets }"} <span className="text-plum">from</span> <span className="text-teal">&quot;@sikrets/sdk&quot;</span>
                    {"\n\n"}
                    <span className="text-plum">const</span> anthropic = <span className="text-plum">new</span> Anthropic({"{"}
                    {"\n"}  apiKey: <span className="text-plum">await</span> sikrets.get(<span className="text-teal">&quot;ANTHROPIC_API_KEY&quot;</span>),{"\n"}
                    {"}"})
                  </Terminal>
                </Card>
              </Reveal>
              <Reveal delay={160}>
                <Card title="MCP" body="One server over stdio. Any agent that speaks MCP." className="h-full">
                  <Terminal title="mcp.json" size="sm">
                    {"{\n"}
                    {"  "}
                    <span className="text-teal">&quot;mcpServers&quot;</span>: {"{\n"}
                    {"    "}
                    <span className="text-teal">&quot;sikrets&quot;</span>: {"{ "}
                    <span className="text-teal">&quot;command&quot;</span>: <span className="text-pine">&quot;sikrets&quot;</span>, <span className="text-teal">&quot;args&quot;</span>: [<span className="text-pine">&quot;mcp&quot;</span>] {"}\n"}
                    {"  }\n}"}
                  </Terminal>
                </Card>
              </Reveal>
            </div>
          </Container>
        </section>

        {/* Performance */}
        <section id="performance" className="bg-night py-20 text-white md:py-32">
          <Container>
            <Reveal>
              <Headline light align="center" eyebrow="The hot path" sub="A Rust policy gateway and a signed ledger, fast enough to sit in front of everything.">
                Every action asks. <em>Every answer is kept.</em>
              </Headline>
            </Reveal>
            <Reveal className="mt-14" delay={100}>
              <div className="grid grid-cols-2 border border-white/15 md:grid-cols-[1fr_1.1fr_1fr]">
                <Stat value="9.4" unit="ns" label="per policy decision" className="border-b border-r border-white/15 md:col-start-1 md:row-start-1" />
                <Stat value="83" unit="ns" label="per ledger append" className="border-b border-white/15 md:col-start-1 md:row-start-2 md:border-b-0 md:border-r" />
                <div className="blueprint relative col-span-2 flex h-44 items-center justify-center border-b border-white/15 md:col-span-1 md:col-start-2 md:row-span-2 md:row-start-1 md:h-auto md:border-b-0 md:border-r">
                  <span className="absolute left-4 top-4 size-4 border-l border-t border-white/50" aria-hidden />
                  <span className="absolute right-4 top-4 size-4 border-r border-t border-white/50" aria-hidden />
                  <span className="absolute bottom-4 left-4 size-4 border-b border-l border-white/50" aria-hidden />
                  <span className="absolute bottom-4 right-4 size-4 border-b border-r border-white/50" aria-hidden />
                  <svg width="88" height="88" viewBox="0 0 20 20" fill="none" aria-hidden>
                    <rect x="1" y="1" width="18" height="18" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8" />
                    <circle cx="8" cy="10" r="3" stroke="#fff" strokeWidth="0.8" />
                    <path d="M11 10H16M14 10V12.5" stroke="#fff" strokeWidth="0.8" />
                  </svg>
                </div>
                <Stat value="1.5" unit="ms" label="to scan 58k nodes and 210k edges" className="border-r border-white/15 md:col-start-3 md:row-start-1 md:border-b md:border-r-0" />
                <Stat value="187k" unit="req/s" label="gateway deny path, p50 0.27 ms" className="md:col-start-3 md:row-start-2" />
              </div>
              <p className="mt-4 text-center font-mono text-[11px] text-white/45">Apple M3 Pro, release build.</p>
            </Reveal>
          </Container>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-24 py-20 md:py-32">
          <Container>
            <Reveal>
              <Headline eyebrow="Simple and open" sub="Open source to run yourself. Hosted when you'd rather not.">
                Free to <em>start.</em>
              </Headline>
            </Reveal>
            <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { name: "Free", price: "Free", note: "Open source and hosted", href: waitlistUrl, cta: "Get started", variant: "outline" as const, points: ["CLI, SDK and MCP server", "Hosted vault", "Stand-ins and rotation", "Activity log"] },
                { name: "Team", price: "Per identity", note: "People and agents alike", href: waitlistUrl, cta: "Join the waitlist", variant: "primary" as const, badge: "Coming soon", points: ["Everything in Free", "Grants and revocation", "Scan on every change", "Signed ledger export"] },
                { name: "Enterprise", price: "Custom", note: "For regulated teams", href: demoUrl, cta: "Talk to us", variant: "outline" as const, points: ["Everything in Team", "Self-hosted gateway", "SSO and SCIM", "Security review and SLA"] },
              ].map((p, i) => (
                <Reveal key={p.name} delay={i * 80}>
                  <div className={`flex h-full flex-col rounded-2xl border p-6 ${p.variant === "primary" ? "border-pine/30 bg-cream" : "border-line bg-cream"}`}>
                    <div className="flex items-center justify-between">
                      <Eyebrow>{p.name}</Eyebrow>
                      {p.badge && <Chip color="pine">{p.badge}</Chip>}
                    </div>
                    <p className="display mt-5 text-4xl text-ink">{p.price}</p>
                    <p className="mt-1.5 text-[15px] text-ink-soft">{p.note}</p>
                    <Pill href={p.href} variant={p.variant} className="mt-6 w-full">
                      {p.cta}
                    </Pill>
                    <ul className="mt-6 space-y-2.5 text-[15px] text-ink-soft">
                      {p.points.map((x) => (
                        <li key={x} className="flex gap-2.5">
                          <Check />
                          {x}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-24 py-20 md:py-32">
          <Container className="grid gap-12 md:grid-cols-[1fr_1.6fr]">
            <Reveal>
              <Headline eyebrow="FAQ">Questions</Headline>
              <p className="mt-6 text-[15px] text-ink-soft">
                Something else?{" "}
                <a href={demoUrl} className="text-ink underline underline-offset-4">
                  Get in touch
                </a>
                .
              </p>
            </Reveal>
            <Reveal delay={80}>
              <Accordion items={faq} />
            </Reveal>
          </Container>
        </section>

        {/* Closing */}
        <section className="px-2 pb-2 sm:px-4 md:px-6">
          <div className="rounded-2xl bg-night px-5 py-24 text-center text-white md:rounded-[1.75rem] md:py-36">
            <Reveal>
              <h2 className="display text-[2.5rem] sm:text-5xl md:text-[3.75rem]">
                <span className="block text-white/50">Standing access is the attack path.</span>
                <span className="block">Close it before it&apos;s used.</span>
              </h2>
              <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                <Pill href={waitlistUrl}>Get started</Pill>
                <Pill href={demoUrl} variant="light">
                  Book a demo
                </Pill>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="bg-night text-white">
        <Container className="grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <SikretsMark size={20} />
              <span className="font-serif text-[1.65rem] leading-none tracking-tight">Sikrets</span>
            </div>
            <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.08em] text-white/50">Contact</p>
            <a href={demoUrl} className="mt-1 block font-serif text-2xl text-white/90 hover:text-white">
              Book a call
            </a>
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
          <span>© {new Date().getFullYear()} Tennant · All rights reserved</span>
        </Container>
      </footer>
    </div>
  )
}
