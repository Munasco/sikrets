// Every fixed value the server relies on, in one place. The wire protocol (paths, proof header,
// envelope prefix, name patterns) is shared with the CLI: keep PROTOCOL and VALUES in step with
// packages/cli/src/constants.ts (DEVICE_AUTH, SERVER_API, ENVELOPE).

export const SERVICE = "sikrets";
/** Bumped when a client would need to change to keep working. */
export const API_VERSION = 1;

// ── Configuration (environment variables) ─────────────────────────────────
export const ENV = {
  host: "SIKRETS_SERVER_HOST",
  port: "SIKRETS_SERVER_PORT",
  /** "aws" (DynamoDB, the default and the one supported store) or "sqlite" (local development and tests only). */
  store: "SIKRETS_SERVER_STORE",
  /** SQLite: folder for the database file. */
  dataDir: "SIKRETS_SERVER_DATA",
  /** "1" lets the dev SQLite store listen beyond this machine (a shared dev box). Never in production. */
  dev: "SIKRETS_SERVER_DEV",
  /** AWS: DynamoDB table and region. Credentials come from the standard AWS chain. */
  table: "SIKRETS_SERVER_TABLE",
  region: "SIKRETS_SERVER_REGION",
  /** The URL clients use, when the server sits behind a proxy that changes scheme, host or port. Proofs are checked against it. */
  publicUrl: "SIKRETS_SERVER_PUBLIC_URL",
  /** "auto" approves every sign-in as the local user (loopback only); "manual" waits for an approver. */
  approval: "SIKRETS_SERVER_APPROVAL",
  /** The account every sign-in belongs to in auto mode. */
  localUser: "SIKRETS_SERVER_USER",
  /** Manual mode: lets an operator approve a sign-in for any account (Authorization: Bearer). */
  adminToken: "SIKRETS_SERVER_ADMIN_TOKEN",
  maxValueBytes: "SIKRETS_SERVER_MAX_VALUE_BYTES",
} as const;

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 4873,
  store: "aws",
  approval: "auto",
  localUser: "you@localhost",
  table: "sikrets",
  region: "us-east-1",
} as const;

/** Hosts auto approval may listen on: anyone who can reach the server is signed in. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** The value of ENV.dev that turns it on. */
export const DEV_ON = "1";

/** Local development and tests only; production runs on DynamoDB. */
export const SQLITE = {
  file: "sikrets.db",
  /** ":memory:" keeps everything in the process (tests). */
  memory: ":memory:",
} as const;

// ── Device sign-in and request proofs (CLI: DEVICE_AUTH) ──────────────────
export const PROTOCOL = {
  paths: {
    info: "/v1/info",
    authorize: "/v1/devices/authorize",
    token: "/v1/devices/token",
    approve: "/v1/devices/approve",
    devices: "/v1/devices",
    revoke: "/v1/devices/:id/revoke",
    me: "/v1/me",
    audit: "/v1/audit",
    values: "/v1/projects/:project/environments/:environment/values",
    value: "/v1/projects/:project/environments/:environment/values/:name",
  },
  proofHeader: "sikrets-device-proof",
  proofType: "sikrets-device-proof+jwt",
  certificateType: "sikrets-device-cert+jwt",
  alg: "ES256",
  clockSkewSeconds: 60,
  /** Longer than the skew window, so a replay is always caught. */
  nonceTtlSeconds: 300,
  maxNonceChars: 128,
  /** RFC 8628 wording for "nobody approved yet". */
  pending: "authorization_pending",
  pollIntervalSeconds: 1,
  approvalTimeoutMs: 5 * 60_000,
  userCodeChars: 8,
  /** Consonants only, so a code never spells a word and survives being read aloud. */
  userCodeAlphabet: "BCDFGHJKLMNPQRSTVWXZ",
  deviceIdPrefix: "dev_",
  requestIdPrefix: "dar_",
  deviceKinds: ["secure-enclave", "software"],
  maxDeviceName: 64,
} as const;

// ── Sealed values (CLI: ENVELOPE, isVaultKey, project names) ──────────────
export const VALUES = {
  /** The only thing the server stores: `sk1:` then base64 of iv | ciphertext | tag. */
  envelopePrefix: "sk1:",
  envelopeMinBytes: 12 + 16,
  base64: /^[A-Za-z0-9+/]+={0,2}$/,
  name: /^[A-Z][A-Z0-9_]{0,127}$/,
  project: /^[a-z0-9][a-z0-9-]{0,62}$/,
  environment: /^[a-z][a-z0-9-]{0,31}$/,
  defaultEnvironment: "dev",
  /** Largest envelope accepted, in bytes. A 4 KB PEM seals to about 5.5 KB. */
  maxValueBytes: 64 * 1024,
  /** Room for the JSON around the largest value. */
  bodyOverheadBytes: 1024,
} as const;

/** Account ids end up inside storage keys, so they never contain the key separator or spaces. */
export const ACCOUNT = /^[^\s#]{1,254}$/;

export const AUDIT = {
  defaultLimit: 50,
  maxLimit: 500,
} as const;

// ── DynamoDB single-table layout ──────────────────────────────────────────
export const DYNAMO = {
  /** Partition and sort key attribute names; every item also has `data` (JSON) and maybe `expiresAt`. */
  pk: "pk",
  sk: "sk",
  data: "data",
  /** Epoch seconds; enable the table's TTL on this attribute so expired nonces and sign-ins are swept. */
  ttl: "expiresAt",
  none: "-",
} as const;
