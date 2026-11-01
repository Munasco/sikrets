// Every fixed value Sikrets relies on, in one place: names, paths, prefixes, URLs and defaults.
// Change them here, never inline.

// ── Product ────────────────────────────────────────────────────────────────
export const SITE_URL = "https://sikrets.usetennant.com";
export const SCHEMA_URL = `${SITE_URL}/schema.json`;
export const USER_AGENT = "sikrets-cli";

// ── Environment variables Sikrets reads ───────────────────────────────────
export const ENV = {
  /** Overrides ~/.sikrets (connections, browser profiles, run logs). */
  configDir: "SIKRETS_CONFIG_DIR",
  /** Overrides the project's vault for one run: "ssm" or "keychain". */
  vault: "SIKRETS_VAULT",
  /** Terraform-compatible binary to use instead of terraform/tofu on PATH. */
  terraform: "SIKRETS_TERRAFORM",
  /** Project name for the SDK when it can't infer one. */
  project: "SIKRETS_PROJECT",
  /** Overrides the phone relay URL (e.g. a local relay for development). */
  relay: "SIKRETS_RELAY_URL",
} as const;

// ── Files and folders ─────────────────────────────────────────────────────
/** Per-user folder under $HOME. */
export const USER_DIR = ".sikrets";
/** Per-project folder for machine-written state. */
export const PROJECT_DIR = ".sikrets";
export const FILES = {
  config: "sikrets.json",
  lock: "sikrets.lock",
  state: "state.json",
  journal: "journal.json",
  activity: "activity.jsonl",
  connections: "connections.json",
} as const;
export const IAC_DIR = "iac/terraform";

// ── Defaults for sikrets.json ─────────────────────────────────────────────
export const DEFAULTS = {
  vault: "ssm",
  envFile: ".env",
  rotateEvery: "30d",
} as const;

// ── Stand-ins ─────────────────────────────────────────────────────────────
export const STAND_IN = {
  prefix: "sk-sikrets-",
  length: 32,
  pattern: /^sk-sikrets-[A-Za-z0-9]{32}$/,
  /** Vault key under which a real key's stand-in is stored. */
  vaultKeyPrefix: "SIKRETS_STANDIN__",
} as const;

// ── Vault namespaces ──────────────────────────────────────────────────────
/** OS keychain service for provider logins and minted management keys. */
export const KEYCHAIN_SERVICE = "dev.sikrets";
/** OS keychain service for one project's values. */
export const keychainVaultService = (project: string) => `${KEYCHAIN_SERVICE}.vault.${project}`;
/** SSM Parameter Store path prefix; values live at /sikrets/<project>/<KEY>. */
export const SSM_PREFIX = "/sikrets";

/** Tag applied to cloud resources Sikrets creates (and used to find them for cost). */
export const MANAGED_BY_TAG = "sikrets";

// ── Providers ─────────────────────────────────────────────────────────────
export const PROVIDER_URLS = {
  upstash: {
    api: "https://api.upstash.com/v2",
    login: "https://console.upstash.com/login",
    apiKeys: "https://console.upstash.com/account/api",
  },
  anthropic: {
    api: "https://api.anthropic.com",
    apiVersion: "2023-06-01",
    keys: "https://platform.claude.com/settings/keys",
  },
  openai: { login: "https://platform.openai.com/login" },
  x: { login: "https://x.com/i/flow/login" },
} as const;

// ── Recovery ──────────────────────────────────────────────────────────────
export const RECOVERY = {
  /** Per-user file holding the wrapped data key (never the key or the code). */
  file: "recovery.json",
  /** Keychain slot for this device's copy of the data key. */
  dataKeyProvider: "datakey",
  dataKeyAccount: "default",
  dataKeyBytes: 32,
  /** Random bytes in a recovery code (160 bits), before the checksum group. */
  codeBytes: 20,
  /** Crockford base32: no I, L, O or U, so codes survive being read aloud or handwritten. */
  alphabet: "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
  groupSize: 4,
  checksumChars: 4,
  sharePrefix: "S",
  shares: 3,
  threshold: 2,
  /** Argon2id per RFC 9106's second recommendation (64 MiB, 3 passes). scrypt is the fallback. */
  argon2: { memoryKiB: 65_536, passes: 3, parallelism: 4 },
  scrypt: { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
  saltBytes: 16,
  ivBytes: 12,
  /** Bound into every wrap as AES-GCM associated data. */
  aad: "sikrets-recovery-v1",
  fingerprintLabel: "sikrets-datakey-fingerprint",
} as const;

// ── Doorman (human approval before rotating) ──────────────────────────────
export const APPROVALS_FILE = "approvals.json";
/** Pending requests lapse after this long without a decision. */
export const APPROVAL_TTL = "24h";
/** What a person is told. Generic on purpose: never the detection source. */
export const APPROVAL_REASONS = {
  exposed: "We think this key may be exposed",
  expired: "This key is past its rotation date",
  requested: "An agent asked to rotate this key",
} as const;
export const DOORMAN = {
  title: "Sikrets",
  /** Compiled Touch ID helpers are cached here, under the user folder. */
  binDir: "bin",
  helperName: "sikrets-touchid",
  dialogTimeoutSeconds: 120,
  approveButton: "Approve",
  denyButton: "Deny",
} as const;

// ── Phone relay (pairing and approvals from the Sikrets app) ──────────────
export const RELAY = {
  /** Zero-knowledge mailbox (apps/relay): AWS Lambda + DynamoDB in us-east-1. */
  url: "https://ooia2zcrrcwjoryuhochzfyczm0rkvka.lambda-url.us-east-1.on.aws",
  /** Per-user file: which phone is paired (public keys and box ids, never a secret key). */
  pairingFile: "pairing.json",
  /** Per-project file: one-time challenges for requests shown on the phone. */
  projectFile: "relay.json",
  /** Keychain slot for the CLI's pairing secret and X25519 secret key. */
  keychainProvider: "pairing",
  keychainAccount: "default",
  /** How long `sikrets pair` waits for the phone to scan. */
  pairTimeoutMs: 5 * 60_000,
  pollMs: 3_000,
  /** How long a pushed snapshot stays on the relay before it lapses. */
  snapshotTtlSeconds: 60 * 60,
  /** Closed requests stay visible on the phone this long. */
  recentMs: 24 * 60 * 60_000,
  /** Snapshot message id prefix; a short hash of the project path follows. */
  snapshotIdPrefix: "snapshot",
} as const;
