export const site = {
  name: "Sikrets",
  url: "https://sikrets.usetennant.com",
  tagline: "Your virtual security guard",
  title: "Sikrets — Your virtual security guard",
  description:
    "An AI security agent for you and your company. It watches your devices, accounts and agents, holds what looks wrong and asks before it acts. Runs in confidential compute. Open source, by Tennant.",
  githubUrl: "https://github.com/Munasco/sikrets",
  tennantUrl: "https://usetennant.com",
  twitter: "@tennantcloud",
  waitlistUrl: "https://usetennant.com/waitlist",
  demoUrl: "https://cal.com/munachi-ernest-eze/custom?duration=20",
  /** Waitlist accepts a prefilled email. */
  waitlistWithEmail: (email: string) => `https://usetennant.com/waitlist?email=${encodeURIComponent(email)}`,
}

/** Origin for absolute metadata URLs. Vercel previews use their own branch URL so Open Graph
 *  images resolve to the preview's own image, not production's. */
const previewHost = process.env.VERCEL_ENV === "preview" ? (process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL) : undefined
export const metadataOrigin = previewHost ? `https://${previewHost}` : site.url
