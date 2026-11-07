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
} as const;

// ── Files and folders ─────────────────────────────────────────────────────
/** Per-user folder under $HOME. */
export const USER_DIR = ".sikrets";
/** Per-project folder for machine-written state. */
export const PROJECT_DIR = ".sikrets";
export const ORPHANS_DIR = "orphans";
export const FILES = {
  config: "sikrets.json",
  lock: "sikrets.lock",
  state: "state.json",
  journal: "journal.json",
  activity: "activity.jsonl",
  connections: "connections.json",
  /** Lock name held while expired personal resources are deleted. */
  sweep: "sweep",
} as const;
export const IAC_DIR = "iac/terraform";

// ── Cross-process file locks ──────────────────────────────────────────────
export const LOCK = {
  /** Suffix of the lock file next to the file it guards. */
  suffix: ".lock",
  /** How long to wait for another sikrets process before giving up. */
  waitMs: 15_000,
  retryMs: 50,
  /** A lock file with no owner written in it, older than this, is treated as left by a crash. */
  staleMs: 60_000,
} as const;

// ── Defaults for sikrets.json ─────────────────────────────────────────────
export const DEFAULTS = {
  vault: "ssm",
  envFile: ".env",
  rotateEvery: "30d",
  /** Lifetime of a resource from `sikrets get` before it is deleted. */
  getExpires: "24h",
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
/** OS keychain service holding a rotated credential until it is safely in the project's vault. */
export const keychainRecoveryService = (project: string) => `${KEYCHAIN_SERVICE}.recovery.${project}`;
/** Name prefix of provider API keys Sikrets mints; the rest is a timestamp so each is findable. */
export const MINTED_KEY_PREFIX = "sikrets-";
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
