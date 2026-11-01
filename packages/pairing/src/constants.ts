// Fixed values of the pairing protocol. The CLI and the app must agree on every one of them, so
// they live here, in the module both import.

export const PROTOCOL_VERSION = 1;

/** What the pairing QR code encodes: this prefix, then the offer as base64url JSON. */
export const OFFER_PREFIX = "sikrets://pair#";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const CHALLENGE_BYTES = 16;

/** HKDF labels. Each derived value gets its own, so no two ever share key material. */
export const LABELS = {
  pairingId: "sikrets/v1/pairing-id",
  boxToPhone: "sikrets/v1/box/to-phone",
  boxToCli: "sikrets/v1/box/to-cli",
  hello: "sikrets/v1/hello-key",
  session: "sikrets/v1/session-key",
} as const;

/** AEAD associated data: binds every ciphertext to its direction, so one can't be replayed as another. */
export const AAD = {
  hello: "sikrets/v1/aad/hello",
  toPhone: "sikrets/v1/aad/to-phone",
  toCli: "sikrets/v1/aad/to-cli",
} as const;

/** Prefix of the exact bytes a phone signs to approve or deny a request. */
export const DECISION_CONTEXT = "sikrets-doorman-decision-v1";

/** A signed decision older than this is refused even if its request is still open. */
export const DECISION_MAX_AGE_MS = 15 * 60_000;
/** Tolerated clock drift between phone and laptop. */
export const CLOCK_SKEW_MS = 2 * 60_000;

/** Relay message ids with a fixed meaning. Other messages use random ids. */
export const MESSAGE_IDS = {
  hello: "hello",
  snapshot: "snapshot",
} as const;

/** Relay mailbox limits. The relay enforces them; clients stay inside them. */
export const RELAY_LIMITS = {
  /** Box ids are 128-bit hex, derived from the pairing secret. */
  boxPattern: /^[0-9a-f]{32}$/,
  idPattern: /^[a-z0-9]{1,32}$/,
  maxBlobChars: 32_768,
  maxMessagesPerBox: 50,
  defaultTtlSeconds: 15 * 60,
  minTtlSeconds: 60,
  maxTtlSeconds: 24 * 60 * 60,
} as const;
export const RELAY_API_PREFIX = "/v1/boxes";
