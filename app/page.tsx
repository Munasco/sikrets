import Image from "next/image"
import { Accordion, Card, EmailForm, Headline, MarkTile, Mock, Stat, VaultDiagram } from "@/components/landing"
import { SikretsMark } from "@/components/logo"
import { RotatingWord } from "@/components/rotating-word"
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
  { label: "Agents", href: "#agents" },
  { label: "Security", href: "#security" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
]

const subjects = ["key.", "agent.", "API.", "pipeline."]
const providers = ["Upstash", "Anthropic", "AWS", "OpenAI", "Cloudflare", "Neon", "Resend", "Supabase"]

const security = [
  { q: "Zero-knowledge encryption", a: "Values are encrypted on your device before they leave it. Sikrets stores ciphertext it cannot read." },
  { q: "Secrets that refuse to print", a: "Inside the CLI every credential is a Secret value: logs, errors, JSON and debug output only ever show dots." },
  { q: "Stand-ins everywhere", a: "Projects, CI and hosting platforms hold stand-ins. A leaked .env file opens nothing." },
  { q: "Scoped access", a: "Each project can read only its own path in the vault, enforced by your cloud's IAM." },
  { q: "Open source", a: "The CLI and SDK are open source, so every claim on this page can be checked in the code." },
]

const faq = [
  { q: "What is Sikrets?", a: "A security platform for the agent era. It creates the credentials your apps and agents need, keeps them in a vault, rotates them on a schedule, and gives projects stand-ins instead of raw keys." },
  { q: "What's a stand-in?", a: "A random value that takes a real key's place in .env files, CI and hosting platforms. Your app resolves it with sikrets.get() or sikrets run; on its own it opens nothing." },
  { q: "Which providers work today?", a: "Upstash, Anthropic and AWS, with 150+ developer services catalogued and new recipes added often." },
  { q: "How do agents use it?", a: "Agents refer to keys by name and run commands through sikrets run, so they never handle the values." },
  { q: "Can Sikrets see my keys?", a: "No. Encryption happens on your device; the hosted vault only ever stores ciphertext." },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <a href="#product" className="block bg-gradient-to-r from-neutral-800 via-neutral-600 to-neutral-800 py-2.5 text-center text-[13px] text-white">
        Sikrets is open source and in private beta <span className="ml-3 text-neutral-300">Learn more →</span>
      </a>

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
            <span className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-black/40 px-3 py-1 text-xs text-neutral-300 backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-[#9ca99a]" /> Open source · zero-knowledge
            </span>
            <h1 className="font-serif text-6xl leading-[1] tracking-tight md:text-7xl">
              Secure every{" "}
              <em className="italic">
                <RotatingWord words={subjects} className="text-white" />
              </em>
            </h1>
            <p className="mt-5 max-w-md text-lg text-neutral-300">The security platform for the agent era. Create, keep and rotate every credential, from one CLI.</p>
            <div className="mt-8">
              <EmailForm action={waitlistUrl} cta="Get started" id="hero-email" />
            </div>
          </div>
          <div className="relative -mt-28 pb-14 text-center">
            <p className="text-sm text-neutral-400">Recipes for Upstash, Anthropic and AWS today · 150+ developer services catalogued</p>
            <div className="mx-auto mt-6 flex max-w-5xl flex-wrap items-center justify-center gap-x-10 gap-y-4 px-6">
              {providers.map((p) => (
                <span key={p} className="text-xl font-semibold tracking-tight text-neutral-500">
                  {p}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* A strong foundation */}
        <section id="product" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-28">
          <Headline sub="Sikrets creates each credential, keeps it out of your code, and replaces it before it can leak.">
            A <em>strong</em> security foundation
          </Headline>
          <div className="mt-14 grid gap-4 md:grid-cols-2">
            <Card image="/landing/vault.jpg" alt="An open vault door with soft green light" title="The vault" body="Real values live encrypted in a vault only you can read." className="min-h-[24rem]" />
            <Card image="/landing/standin.jpg" alt="A steel key beside an identical glass key" title="Stand-ins" body="Your .env, CI and platforms hold a copy that opens nothing." className="min-h-[24rem]" />
            <Card image="/landing/rotate.jpg" alt="A key turning inside a ring of light" title="Automatic rotation" body="Keys renew on schedule. Stand-ins never change, so nothing needs redeploying." className="min-h-[26rem] md:col-span-2" imageClassName="object-[center_40%]" />
          </div>
        </section>

        {/* Statement */}
        <section className="mx-auto max-w-4xl px-6 pb-28 text-center">
          <p className="font-serif text-4xl leading-tight md:text-5xl">
            “Steal every stored key. <em className="italic">They still won’t work.</em>”
          </p>
          <p className="mt-6 text-sm text-neutral-500">The principle Sikrets is built on</p>
        </section>

        {/* Stats */}
        <section className="mx-4 rounded-3xl border border-white/10 bg-gradient-to-b from-neutral-900 to-black md:mx-auto md:max-w-5xl">
          <div className="grid grid-cols-2 gap-10 px-6 py-12 md:grid-cols-4">
            <Stat value="150+" label="providers catalogued" />
            <Stat value="0" label="raw keys in your repo" />
            <Stat value="30d" label="default rotation" />
            <Stat value="1" label="CLI for all of it" />
          </div>
        </section>

        {/* Agent-native */}
        <section id="agents" className="mx-auto max-w-6xl scroll-mt-24 px-6 py-28">
          <Headline sub="Agents work with names, never values. Every use is on the record.">
            Amplified with <em>agent-native</em> tools
          </Headline>
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            <Card title="sikrets run" body="Commands get the keys they need for as long as they run.">
              <Mock title="terminal" hot={[0]} lines={["$ sikrets run -- claude", "  ANTHROPIC_API_KEY       injected", "  CACHE_REDIS_REST_TOKEN  injected"]} />
            </Card>
            <Card title="The SDK" body="Apps resolve stand-ins at runtime and pick up rotations on their own.">
              <MarkTile />
            </Card>
            <Card title="Activity" body="Who used which key, when, and how it went. Names only.">
              <Mock title="sikrets activity" lines={["10:42  run     bun (exit 0)", "10:40  rotate  upstash/redis", "10:31  add     anthropic/api-key"]} />
            </Card>
          </div>
        </section>

        {/* Deterministic tools */}
        <section className="mx-auto max-w-6xl px-6 pb-28">
          <Headline sub="Every change is planned, reversible and priced before it happens.">
            Coupled with <em>deterministic</em> tools
          </Headline>
          <div className="mt-14 grid gap-4 md:grid-cols-3">
            <Card title="Dry run" body="See every change and its cost first.">
              <Mock title="--dry-run" lines={['+ Create upstash/redis "cache"', "+ Store 2 keys in the vault", "+ Write stand-ins to .env"]} />
            </Card>
            <Card title="Rollback" body="Undo an add exactly, step by step.">
              <Mock title="sikrets rollback" lines={['- Forget "cache"', "- Remove stand-ins from .env", '- Delete upstash/redis "cache"']} />
            </Card>
            <Card title="Cost" body="Live spend where providers report it.">
              <Mock title="sikrets cost" lines={["cache   upstash/redis  $0.00", "web     aws/ec2        ~$3.07/mo"]} />
            </Card>
            <Card title="Status" body="Every resource, when it was last used, and when it rotates." className="md:col-span-2">
              <Mock title="sikrets status" hot={[1]} lines={["NAME       RECIPE             STATE  LAST USED  ROTATE", "cache      upstash/redis      live   2h ago     in 28d", "anthropic  anthropic/api-key  live   5m ago     in 30d"]} />
            </Card>
            <Card title="sikrets.json" body="One committed file describes the project.">
              <Mock title="sikrets.json" lines={['{ "project": "shop",', '  "vault": "ssm",', '  "rotateEvery": "30d" }']} />
            </Card>
          </div>
        </section>

        {/* Secure by design */}
        <section id="security" className="mx-auto max-w-6xl scroll-mt-24 px-6 pb-28">
          <Headline sub="Built so that a leak, a log line or a curious agent never exposes a real key.">
            Secure by design
          </Headline>
          <div className="mt-14 grid items-center gap-10 md:grid-cols-2">
            <VaultDiagram />
            <Accordion items={security} />
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="mx-auto max-w-4xl scroll-mt-24 px-6 pb-28">
          <Headline align="left">
            <em>Open</em> by default, hosted when you want it
          </Headline>
          <div className="mt-12 grid gap-10 border-t border-white/10 pt-10 md:grid-cols-2">
            {[
              { name: "Open source", price: "$0", note: "/month", cta: "Start for free", primary: false, points: ["CLI and SDK", "Your own AWS vault", "Every recipe and rotation", "Community support"] },
              { name: "Cloud", price: "Soon", note: "", cta: "Join the beta", primary: true, points: ["Zero-knowledge hosted vault", "Team sharing and audit log", "Agent policies", "Priority support"] },
            ].map((p) => (
              <div key={p.name}>
                <p className="text-sm text-neutral-400">{p.name}</p>
                <p className="mt-1 font-serif text-5xl">
                  {p.price} <span className="font-sans text-sm text-neutral-500">{p.note}</span>
                </p>
                <a href={waitlistUrl} className={`mt-6 block rounded-full py-2.5 text-center text-sm ${p.primary ? "bg-white text-black hover:bg-neutral-200" : "border border-white/25 hover:bg-white/10"}`}>
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
            <h2 className="font-serif text-5xl leading-[1.02]">Frequently asked questions</h2>
            <p className="mt-4 text-sm text-neutral-400">
              Don&apos;t see your question?{" "}
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
            <p className="mt-4 text-neutral-300">Open source. Your keys never leave your control.</p>
            <div className="mt-9 flex justify-center">
              <EmailForm action={waitlistUrl} cta="Start for free" id="cta-email" />
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
            { h: "Product", l: [["The vault", "#product"], ["Agents", "#agents"], ["Pricing", "#pricing"]] },
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
