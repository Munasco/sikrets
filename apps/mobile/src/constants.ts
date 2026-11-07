// Every fixed value the app relies on. Change them here, never inline.

export const COLORS = {
  background: "#fbfaf7",
  cream: "#f4f3f1",
  forest: "#1f3b2d",
  pine: "#1f4a3a",
  muted: "#b3aea7",
  ink: "#1c1b19",
  line: "#e7e4df",
  danger: "#8a2f24",
  white: "#ffffff",
} as const;

export const FONTS = {
  regular: "Geist_400Regular",
  medium: "Geist_500Medium",
  semibold: "Geist_600SemiBold",
  mono: "GeistMono_400Regular",
} as const;

/** Arch-with-keyhole mark, on a 24×24 grid. */
export const LOGO_PATH = "M4 22V10.5a8 8 0 0 1 16 0V22zM12 9.2a2.2 2.2 0 0 0-1.1 4.1L10.4 18h3.2l-.5-4.7A2.2 2.2 0 0 0 12 9.2z";

/** The hosted security-agent chat (apps/agent on the agent-harden stack). */
export const AGENT_CHAT_URL = "https://dan27asb93qem.cloudfront.net";

/** How often the app checks the relay while open. Real push needs an Apple developer account. */
export const POLL_MS = 5_000;
/** Sent answers remembered (newest kept); older ones belong to long-closed requests. */
export const SENT_MEMORY = 100;
/** How long a signed answer waits on the relay for the laptop. */
export const ANSWER_TTL_SECONDS = 15 * 60;

/** Keychain entries (expo-secure-store). */
export const STORAGE = {
  /** Pairing record: relay, laptop public key, pairing secret, this phone's X25519 key. */
  pairing: "sikrets.pairing.v1",
  /**
   * Ed25519 signing key; behind Face ID wherever the platform allows it. Each pairing gets its own
   * slot (this plus "." and the start of its pairing id), so a new key never replaces the one the
   * current pairing uses until the laptop has accepted the new one. Bare: pairings from before that.
   */
  signKey: "sikrets.signkey.v1",
  /** Answers this phone sent, by request and challenge, so they survive a restart. */
  sent: "sikrets.sent.v1",
  /** Ids of requests already notified about, so each one notifies once. */
  notified: "sikrets.notified.v1",
} as const;

export const COPY = {
  faceIdApprove: "Approve rotating this key",
  faceIdDeny: "Deny this rotation",
  phoneName: "iPhone",
  unpairedByLaptop: "This laptop unpaired. Scan a new code to pair again.",
} as const;
