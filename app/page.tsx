import { Accordion, Card, Check, Chip, Container, Denied, Eyebrow, Headline, HeroButton, Pill, SessionCard, SessionLog, Stat, Terminal } from "@/components/landing"
import { SikretsMark } from "@/components/logo"
import { PathToggle } from "@/components/path-toggle"
import { Reveal } from "@/components/reveal"
import { SessionFlow } from "@/components/session-flow"
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
  { label: "The case", href: "#case" },
  { label: "Developers", href: "#developers" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

/** Services with hand-written proxy support; the rest of the catalog is brokered from its known API hosts. */
const services = ["GitHub", "Slack", "Anthropic", "OpenAI", "Stripe", "Resend"]

const faq = [
  { q: "What is Sikrets?", a: "1Password for agents. Your keys stay with you; an agent gets a session that works through a local proxy, ends on time and logs every request." },
  { q: "What does the agent actually see?", a: "A session token (sks_…) in the usual variables, like GITHUB_TOKEN. It only works through this session's proxy, for the services you named, until the session ends." },
  { q: "What is sandboxed?", a: "On macOS the agent can't read the keychain, ~/.ssh, ~/.aws or other credential files, and can only reach the network through the proxy. Linux is next." },
  { q: "Which services work?", a: `${site.servicesBrokered} from the catalog, including GitHub (with git over HTTPS), Slack, Anthropic, OpenAI, Stripe and Resend. Find one with sikrets proxy ls.` },
  { q: "Can Sikrets read my keys?", a: "Hosted storage is zero-knowledge: values are encrypted on your device before upload. Session keys stay in your local keychain." },
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
              <h1 className="display text-balance text-[2.75rem] text-pine sm:text-6xl md:text-[5rem] lg:text-[5.5rem]">
                Give agents access. <br className="hidden sm:block" />
                <em>Never the keys.</em>
              </h1>
              <p className="mt-6 max-w-2xl text-balance text-[17px] leading-relaxed text-ink md:text-lg">A session that ends on time. Your keys stay with you. Every request is logged.</p>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                <HeroButton href={waitlistUrl}>Get started</HeroButton>
                <a href={githubUrl} className="font-serif text-[1.2rem] text-ink underline-offset-4 hover:underline">
                  View on GitHub
                </a>
              </div>
            </div>
            <div className="relative z-10 mx-auto mt-14 max-w-3xl px-3 sm:px-6 md:mt-20">
              <Terminal title="terminal" className="rounded-b-none border-b-0 shadow-[0_-20px_60px_rgba(20,30,25,0.18)]">
                <span className="text-muted">$</span> sikrets session run github,slack \{"\n"}
                {"    "}--for 2h -- claude{"\n"}
                <span className="text-pine">sikrets:</span> session sks_7f3a9c… · ends in 2h{"\n"}
                <span className="text-pine">sikrets:</span> github, slack · sandboxed{"\n\n"}
                <span className="text-muted">claude › </span>echo $GITHUB_TOKEN{"\n"}
                sks_7f3a9c… <span className="text-muted"># a session token, not a key</span>
                {"\n"}
                <span className="text-muted">claude › </span>git push origin main{"\n"}
                <span className="text-pine">  ✓ authenticated through the proxy</span>
                {"\n"}
                <span className="text-muted">claude › </span>cat ~/.ssh/id_ed25519{"\n"}
                <span className="text-rust">  ✗ Operation not permitted</span>
                {"\n\n"}
                <span className="text-pine">sikrets:</span> ended · 38 requests, 0 denied
              </Terminal>
            </div>
          </div>
        </section>

        {/* Works with */}
        <Container className="py-12 md:py-16">
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.08em] text-muted">Works with {site.servicesBrokered} services</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {services.map((p) => (
              <span key={p} className="text-xl font-medium tracking-tight text-faint">
                {p}
              </span>
            ))}
            <span className="font-mono text-[13px] text-muted">+{site.servicesBrokered - services.length} more</span>
          </div>
        </Container>

        {/* How it works */}
        <section id="product" className="scroll-mt-24 py-20 md:py-28">
          <Container>
            <Reveal>
              <Headline eyebrow="How a session works" sub="The agent holds a token that ends. A proxy on your machine adds the real key on the way out.">
                The agent holds a session. <em>You hold the keys.</em>
              </Headline>
            </Reveal>
            <Reveal className="mt-14" delay={100}>
              <SessionFlow />
            </Reveal>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Reveal>
                <Card title="Sandboxed" body="Credential files and direct network are off limits." className="h-full">
                  <Denied items={["keychain", "~/.ssh", "~/.aws", "~/.kube", "~/.npmrc", "direct network"]} />
                </Card>
              </Reveal>
              <Reveal delay={80}>
                <Card title="Rules per service" body="Name a bundle once. Limit methods where it matters." className="h-full">
                  <Terminal title="sikrets.json" size="sm">
                    <span className="text-teal">&quot;bundles&quot;</span>: {"{\n"}
                    {"  "}
                    <span className="text-teal">&quot;code-review&quot;</span>: [{"\n"}
                    {"    "}
                    <span className="text-pine">&quot;github&quot;</span>,{"\n"}
                    {"    { "}
                    <span className="text-teal">&quot;service&quot;</span>: <span className="text-pine">&quot;slack&quot;</span>,{"\n"}
                    {"      "}
                    <span className="text-teal">&quot;methods&quot;</span>: [<span className="text-pine">&quot;GET&quot;</span>] {"}\n"}
                    {"  ]\n}"}
                    {"\n\n"}
                    <span className="text-muted">$</span> sikrets session run code-review \{"\n"}
                    {"    "}-- codex
                  </Terminal>
                </Card>
              </Reveal>
              <Reveal>
                <Card title="Ends on time" body="Expiry or exit revokes the token. Its CA is deleted." className="h-full">
                  <SessionCard />
                </Card>
              </Reveal>
              <Reveal delay={80}>
                <Card title="Every request logged" body="Service, method, path, status, and why it was denied." className="h-full">
                  <SessionLog />
                </Card>
              </Reveal>
            </div>
          </Container>
        </section>

        {/* The case */}
        <section id="case" className="scroll-mt-24 py-20 md:py-24">
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

        {/* Developers */}
        <section id="developers" className="scroll-mt-24 py-20 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Open source" sub="The agent gets the work done. The key stays out of its context.">
                CLI, SDK <em>and MCP.</em>
              </Headline>
            </Reveal>
            <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
              <Reveal>
                <Card title="CLI" body="Store a key once. Run anything with access." className="h-full">
                  <Terminal title="terminal" size="sm">
                    <span className="text-muted">$</span> sikrets proxy add github{"\n"}
                    <span className="text-muted">  # real token → your keychain</span>
                    {"\n\n"}
                    <span className="text-muted">$</span> sikrets proxy ls stripe{"\n"}
                    <span className="text-muted">  # search {site.servicesBrokered} services</span>
                    {"\n\n"}
                    <span className="text-muted">$</span> sikrets run -- bun dev
                  </Terminal>
                </Card>
              </Reveal>
              <Reveal delay={80}>
                <Card title="SDK" body="Ask for the real value at runtime. Stand-ins never come back." className="h-full">
                  <Terminal title="app.ts" size="sm">
                    <span className="text-plum">import</span> {"{ sikrets }"} <span className="text-plum">from</span> <span className="text-teal">&quot;@sikrets/sdk&quot;</span>
                    {"\n\n"}
                    <span className="text-plum">const</span> key = <span className="text-plum">await</span> sikrets.get({"\n"}
                    {"  "}
                    <span className="text-teal">&quot;ANTHROPIC_API_KEY&quot;</span>
                    {"\n"})
                  </Terminal>
                </Card>
              </Reveal>
              <Reveal delay={160}>
                <Card title="MCP" body="Agents run commands with secrets. Output comes back scrubbed." className="h-full">
                  <Terminal title="terminal" size="sm">
                    <span className="text-muted">$</span> claude mcp add sikrets \{"\n"}
                    {"    "}-- sikrets mcp --allow bun{"\n\n"}
                    <span className="text-muted">› run_with_secrets</span> bun run seed.ts{"\n"}
                    {"  "}connected to <span className="text-teal">[secret:DB_URL]</span>
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
              <Headline light align="center" eyebrow="Measured" sub="A local proxy for sessions. A Rust gateway and signed ledger for policy.">
                Fast enough to <em>stay out of the way.</em>
              </Headline>
            </Reveal>
            <Reveal className="mt-14" delay={100}>
              <div className="grid grid-cols-2 border border-white/15 md:grid-cols-[1fr_1.1fr_1fr]">
                <Stat value="48" unit="ms" label="to start a session" className="border-b border-r border-white/15 md:col-start-1 md:row-start-1" />
                <Stat value="0.08" unit="ms" label="added per request by the proxy" className="border-b border-white/15 md:col-start-1 md:row-start-2 md:border-b-0 md:border-r" />
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
                <Stat value="9.4" unit="ns" label="per policy decision" className="border-r border-white/15 md:col-start-3 md:row-start-1 md:border-b md:border-r-0" />
                <Stat value="83" unit="ns" label="per signed ledger append" className="md:col-start-3 md:row-start-2" />
              </div>
              <p className="mx-auto mt-4 max-w-2xl text-center font-mono text-[11px] leading-relaxed text-white/45">Proxy: p50 0.116 ms through it vs 0.035 ms direct, reused connection. Gateway and ledger: Apple M3 Pro, release build.</p>
            </Reveal>
          </Container>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-24 py-20 md:py-24">
          <Container>
            <Reveal>
              <Headline eyebrow="Simple and open" sub="Open source to run yourself. Hosted when you'd rather not.">
                Free to <em>start.</em>
              </Headline>
            </Reveal>
            <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                { name: "Free", price: "Free", note: "Open source and hosted", href: waitlistUrl, cta: "Get started", variant: "outline" as const, points: ["CLI, SDK and MCP server", "Agent sessions and proxy", "Zero-knowledge hosted vault", "Request and activity logs"] },
                { name: "Team", price: "Per identity", note: "People and agents alike", href: waitlistUrl, cta: "Join the waitlist", variant: "primary" as const, badge: "Coming soon", points: ["Everything in Free", "Shared bundles and revocation", "Access for people, too", "Signed ledger export"] },
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
        <section id="faq" className="scroll-mt-24 py-20 md:py-24">
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
                <span className="block text-white/50">Your agents need access.</span>
                <span className="block">Not your keys.</span>
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
