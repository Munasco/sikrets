export const site = {
  name: "Sikrets",
  url: "https://sikrets.usetennant.com",
  tagline: "Give agents access, never the keys",
  title: "Sikrets — Give agents access, never the keys",
  description:
    "Sikrets runs AI agents with a time-limited session instead of your API keys. A local proxy adds the real key on the way out, logs every request and revokes access when the session ends. Open source, by Tennant.",
  /** Catalog services `sikrets session` can broker (known API host and key style). */
  servicesBrokered: 426,
  githubUrl: "https://github.com/Munasco/sikrets",
  tennantUrl: "https://usetennant.com",
  twitter: "@tennantcloud",
  waitlistUrl: "https://usetennant.com/waitlist",
  demoUrl: "https://cal.com/munachi-ernest-eze/custom?duration=20",
  /** Waitlist accepts a prefilled email. */
  waitlistWithEmail: (email: string) => `https://usetennant.com/waitlist?email=${encodeURIComponent(email)}`,
}

/** Origin for absolute metadata URLs. Vercel previews use their own branch URL so Open Graph
 *  images resolve to the preview's image, not production's. */
export const metadataOrigin =
  process.env.VERCEL_ENV === "preview" && process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : site.url
