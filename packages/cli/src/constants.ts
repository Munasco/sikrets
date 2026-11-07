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
  /** Bitwarden CLI command to run instead of `bw` (e.g. "bunx @bitwarden/cli"). */
  bw: "SIKRETS_BW",
  /** 1Password CLI command to run instead of `op`. */
  op: "SIKRETS_OP",
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
  /** Keys imported or linked from outside Sikrets (names and item references only). */
  keys: "keys.json",
} as const;
export const IAC_DIR = "iac/terraform";
/** Cross-process lock next to a file another sikrets process may write at the same time. */
export const FILE_LOCK = {
  suffix: ".lock",
  retryMs: 20,
  /** Give up waiting after this long. */
  timeoutMs: 10_000,
  /** A lock older than this (or whose process is gone) was left by a crash and is taken over. */
  staleMs: 30_000,
} as const;

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

// ── Password managers ─────────────────────────────────────────────────────
export const PASSWORD_MANAGERS = {
  bitwarden: {
    name: "Bitwarden",
    bin: "bw",
    binEnv: ENV.bw,
    /** Env var the bw CLI reads its unlocked session from. */
    sessionEnv: "BW_SESSION",
    /** Where bw points when no self-hosted server is configured. */
    defaultServer: "https://vault.bitwarden.com",
    /** Env var we hand the master password through, so it never appears in argv. */
    passwordEnv: "SIKRETS_BW_PASSWORD",
    /** Where bw keeps its config and encrypted cache; set it to isolate a test run. */
    appDataEnv: "BITWARDENCLI_APPDATA_DIR",
    refScheme: "bw://",
    install: "https://bitwarden.com/help/cli/",
  },
  onepassword: {
    name: "1Password",
    bin: "op",
    binEnv: ENV.op,
    /** `op signin --raw` sessions go in OP_SESSION_<user uuid>. */
    sessionEnvPrefix: "OP_SESSION_",
    /** Service accounts skip sign-in entirely. */
    serviceAccountEnv: "OP_SERVICE_ACCOUNT_TOKEN",
    refScheme: "op://",
    install: "https://developer.1password.com/docs/cli/get-started/",
  },
} as const;

// ── Import ────────────────────────────────────────────────────────────────
export const IMPORT = {
  /** 1Password's .1pux export is a zip; its items are in this file inside it. */
  onePuxData: "export.data",
  unzip: "unzip",
} as const;
