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
  /** One project's derived key (base64), for deployed apps that read the ssm vault without a keychain. */
  projectKey: "SIKRETS_PROJECT_KEY",
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
  /** Lock file (under the user folder) held while creating the data key. */
  dataKeyLock: "datakey",
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

// ── Client-side encryption ────────────────────────────────────────────────
export const ENVELOPE = {
  /** Every value written to a remote vault starts with this; anything else is legacy plaintext. */
  prefix: "sk1:",
  /** Matches any envelope version, so a newer one fails loudly instead of being read as plaintext. */
  versionPattern: /^sk(\d+):/,
  /** HKDF from the data key to one project's key: a deployed app holds that, never the data key. */
  hkdfSalt: "sikrets-project-key",
  hkdfInfo: (project: string) => `sikrets-project-v1|${project}`,
  /** Bound into every value as AES-GCM associated data, with the full parameter name. */
  aad: (name: string) => `sikrets-value-v1|${name}`,
  ivBytes: 12,
  tagBytes: 16,
} as const;
/** sikrets.json "encryption" value that refuses legacy plaintext once a project is migrated. */
export const ENCRYPTION_REQUIRED = "required";

// ── Backups ───────────────────────────────────────────────────────────────
export const BACKUP = {
  format: "sikrets-backup",
  version: 1,
  /** Default folder, under the per-user folder, so a backup never lands inside a repo by accident. */
  dir: "backups",
  extension: ".sikrets-backup",
  /** Default file name: sikrets-<project>-<timestamp>.sikrets-backup */
  fileName: (project: string, at: Date) => `sikrets-${project}-${at.toISOString().replace(/[:.]/g, "-")}.sikrets-backup`,
  /** Matches only fileName()'s output for this project, so pruning never touches another project's files. */
  filePattern: (project: string) => new RegExp(`^sikrets-${project}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.sikrets-backup$`),
  /** HKDF info for the data-key mode, so a backup key never equals a project key. */
  hkdfInfo: "sikrets-backup-v1",
  aad: "sikrets-backup-v1",
  minPassphrase: 12,
  /** --keep default for --dir backups: older files in that folder are pruned. */
  keep: 14,
} as const;

// ── Doorman (human approval before rotating) ──────────────────────────────
export const APPROVALS_FILE = "approvals.json";
/** Pending requests lapse after this long without a decision; a failed rotation gets a fresh window to retry. */
export const APPROVAL_TTL = "24h";
/** A rotation still marked running after this long, or whose process is gone, is recorded as failed. */
export const APPROVAL_ROTATING_MAX_MS = 60 * 60_000;
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

// ── Local state-file locks ────────────────────────────────────────────────
export const LOCK = {
  /** How long to wait for another sikrets process to finish with a file. */
  waitMs: 10_000,
  retryMs: 25,
  /** A lock older than this is assumed abandoned even if its pid looks alive. */
  staleMs: 30_000,
} as const;
