export const site = {
  name: "Sikrets",
  url: "https://sikrets.usetennant.com",
  title: "Sikrets — Find the attack path before the attacker does",
  description:
    "Sikrets keeps credentials in custody, gives people and AI agents time-limited access instead of standing access, and keeps signed evidence of every decision. Open source, by Tennant.",
  githubUrl: "https://github.com/Munasco/sikrets",
  tennantUrl: "https://usetennant.com",
  twitter: "@tennantcloud",
  waitlistUrl: "https://usetennant.com/waitlist",
  demoUrl: "https://cal.com/munachi-ernest-eze/custom?duration=20",
  /** Waitlist accepts a prefilled email. */
  waitlistWithEmail: (email: string) => `https://usetennant.com/waitlist?email=${encodeURIComponent(email)}`,
}
