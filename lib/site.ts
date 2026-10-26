export const site = {
  name: "Sikrets",
  url: "https://sikrets.usetennant.com",
  title: "Sikrets — Security for the agent era",
  description:
    "The security platform for the agent era. Secure every API key your agents and apps use, without ever handing them over. Free and open source.",
  githubUrl: "https://github.com/Munasco/sikrets",
  tennantUrl: "https://usetennant.com",
  twitter: "@tennantcloud",
  waitlistUrl: "https://usetennant.com/waitlist",
  demoUrl: "https://cal.com/munachi-ernest-eze/custom?duration=20",
  /** Waitlist accepts a prefilled email. */
  waitlistWithEmail: (email: string) => `https://usetennant.com/waitlist?email=${encodeURIComponent(email)}`,
}
