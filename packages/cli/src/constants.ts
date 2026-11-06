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
  /** Terraform-compatible binary to use instead of terraform/tofu on PATH. */
  terraform: "SIKRETS_TERRAFORM",
  /** Project name for the SDK when it can't infer one. */
  project: "SIKRETS_PROJECT",
  /** Agent a command hands keys to (same as --agent); see `sikrets agent`. */
  agent: "SIKRETS_AGENT",
  /** Bitwarden CLI command to run instead of `bw` (e.g. "bunx @bitwarden/cli"). */
  bw: "SIKRETS_BW",
  /** 1Password CLI command to run instead of `op`. */
  op: "SIKRETS_OP",
  /** "software" makes a new device identity use software keys even where a Secure Enclave exists. */
  deviceKeys: "SIKRETS_DEVICE_KEYS",
  /** The Sikrets server to use instead of the hosted one (after --server, before sikrets.json). */
  server: "SIKRETS_SERVER",
  /** Set to 1 to run the opt-in Secure Enclave smoke test (silent: no Touch ID, no dialogs). */
  enclaveSmoke: "SIKRETS_ENCLAVE_SMOKE",
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
  agents: "agents.json",
  /** Keys imported or linked from outside Sikrets (names and item references only). */
  keys: "keys.json",
} as const;
/** Folder under the user dir for per-project usage logs (local only, never in the project). */
export const USAGE_DIR = "usage";
export const IAC_DIR = "iac/terraform";

// ── Defaults for sikrets.json ─────────────────────────────────────────────
export const DEFAULTS = {
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
/** Legacy vaults `sikrets migrate` reads from: one project's values in the OS keychain... */
export const keychainVaultService = (project: string) => `${KEYCHAIN_SERVICE}.vault.${project}`;
/** ...or in SSM Parameter Store at /sikrets/<project>/<KEY>. The prefix also stays in every envelope's AAD. */
export const SSM_PREFIX = "/sikrets";
export const LEGACY_VAULTS = ["ssm", "keychain"] as const;

/** Tag applied to cloud resources Sikrets creates (and used to find them for cost). */
export const MANAGED_BY_TAG = "sikrets";

// ── Credential hygiene ────────────────────────────────────────────────────
/** A key is stale when its current value is older than `olderThanDays` and unused for `unusedDays`. */
export const STALE = { olderThanDays: 90, unusedDays: 30 } as const;

export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Over-scope checks that cost at most one cheap request, keyed by the key's prefix. */
export const SCOPES = {
  github: {
    /** Classic tokens report their scopes in X-OAuth-Scopes; fine-grained ones (github_pat_) don't. */
    classicPrefixes: ["ghp_", "gho_", "ghu_"],
    header: "x-oauth-scopes",
    /** Scopes that reach far beyond one repo or grant admin rights. */
    broad: ["repo", "workflow", "admin:org", "admin:repo_hook", "admin:org_hook", "admin:public_key", "admin:gpg_key", "admin:ssh_signing_key", "admin:enterprise", "delete_repo", "write:packages", "delete:packages", "user", "codespace"],
  },
  stripe: {
    /** Secret keys can do anything on the account; restricted keys (rk_) carry only chosen permissions. */
    secretPrefixes: ["sk_live_", "sk_test_"],
    restrictedPrefixes: ["rk_live_", "rk_test_"],
  },
} as const;

// ── Short-lived credentials ───────────────────────────────────────────────
export const GITHUB = {
  api: "https://api.github.com",
  apiVersion: "2022-11-28",
  accept: "application/vnd.github+json",
  appSettings: "https://github.com/settings/apps",
  /** App JWTs: backdated for clock drift, and under GitHub's 10-minute limit. */
  jwtBackdateSeconds: 60,
  jwtLifetimeSeconds: 540,
  /** Env vars an installation token is exported as. */
  tokenEnv: ["GITHUB_TOKEN", "GH_TOKEN"],
} as const;

export const AWS_SESSION = {
  minMinutes: 15,
  maxMinutes: 60,
  defaultDuration: "60m",
  defaultRegion: "us-east-1",
  roleSessionName: "sikrets",
  /** Agent scope that grants sessions from the connected AWS profile (not a stored key). */
  profileScope: "aws-profile",
  securityCredentials: "https://console.aws.amazon.com/iam/home#/security_credentials",
} as const;

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

// ── Client-side encryption ────────────────────────────────────────────────
// Same wire format as the SDK reads (packages/sdk/src/constants.ts): keep the two in step.
export const ENVELOPE = {
  /** Every sealed value starts with this; anything else in a vault is legacy plaintext. */
  prefix: "sk1:",
  /** Any envelope version, so one from a newer CLI fails loudly instead of reading as plaintext. */
  versionPattern: /^sk(\d+):/,
  /** HKDF from the data key to one project's key, so a project key never opens another project. */
  hkdfSalt: "sikrets-project-key",
  hkdfInfo: (project: string) => `sikrets-project-v1|${project}`,
  /** AES-GCM associated data: the value's location, so a ciphertext can't move to another key or project. */
  aad: (project: string, key: string) => `sikrets-value-v1|${SSM_PREFIX}/${project}/${key}`,
  ivBytes: 12,
  tagBytes: 16,
} as const;

// ── Revealing a real value ────────────────────────────────────────────────
export const REVEAL = {
  /** `sikrets get --copy` clears the clipboard after this, if it still holds the value. */
  clipboardClearSeconds: 30,
  /** Env var the clipboard-clearing shell gets the value's SHA-256 in (never the value). */
  clipboardHashEnv: "SIKRETS_CLIPBOARD_SHA256",
  /** Set in CI; nobody is there to answer Touch ID. */
  ciEnv: "CI",
  /** Set in an SSH session, where the dialog would appear on a screen nobody is looking at. */
  sshEnv: ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"],
  /** `launchctl managername` prints this only inside a logged-in GUI session. */
  guiSession: "Aqua",
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

// ── Device identity ───────────────────────────────────────────────────────
// Two P-256 keys per device: one signs request proofs, one wraps the vault data key. On a Mac with
// a Secure Enclave both live there (no user presence, so nothing prompts) and only their opaque
// dataRepresentation blobs are stored; elsewhere they are software keys in 0600 files.
export const DEVICE = {
  /** Folder under the user dir holding the key blobs, the wrapped data key and the session. */
  dir: "device",
  /** Non-secret: which kind of keys this device has and their public halves. */
  metaFile: "device.json",
  signingKey: "signing.key",
  agreementKey: "agreement.key",
  /** The data key wrapped to this device's key-agreement key. */
  dataKeyFile: "datakey.json",
  /** Device id and certificate from `sikrets login`. */
  sessionFile: "session.json",
  /** Compiled Secure Enclave helper (under DOORMAN.binDir), plus a stable link the SDK runs. */
  helperName: "sikrets-device",
  forceSoftware: "software",
  /** Wrapping the data key: ephemeral ECDH, HKDF-SHA256, AES-256-GCM (same values in the SDK). */
  wrapSalt: "sikrets-datakey-wrap",
  wrapInfo: "sikrets-datakey-wrap-v1",
  wrapAad: "sikrets-datakey-v1",
  ivBytes: 12,
  /** Hex characters of a key thumbprint shown or stored to tell keys apart. */
  thumbprintChars: 16,
} as const;

// Device sign-in and per-request proof of possession, in the style of DPoP (RFC 9449): every
// request carries a JWS by the device key over method, URL, time, a one-time nonce and the body
// hash. The server side is packages/server (its PROTOCOL constants must match these).
export const DEVICE_AUTH = {
  paths: {
    info: "/v1/info",
    authorize: "/v1/devices/authorize",
    token: "/v1/devices/token",
    /** Stands in for the browser approval page until the real sign-in flow exists. */
    approve: "/v1/devices/approve",
    devices: "/v1/devices",
    revoke: (id: string) => `/v1/devices/${encodeURIComponent(id)}/revoke`,
    me: "/v1/me",
    values: (project: string, environment: string) => `/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/values`,
    value: (project: string, environment: string, name: string) => `/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/values/${encodeURIComponent(name)}`,
  },
  proofHeader: "sikrets-device-proof",
  proofType: "sikrets-device-proof+jwt",
  certificateType: "sikrets-device-cert+jwt",
  alg: "ES256",
  /** How far a proof's timestamp may be from the server's clock either way. */
  clockSkewSeconds: 60,
  /** How long a nonce is remembered; longer than the skew window, so a replay is always caught. */
  nonceTtlSeconds: 300,
  nonceBytes: 16,
  /** The token endpoint's answer while the person hasn't approved yet (RFC 8628 wording). */
  pending: "authorization_pending",
  pollIntervalMs: 1000,
  approvalTimeoutMs: 5 * 60_000,
  userCodeChars: 8,
  deviceIdPrefix: "dev_",
  requestIdPrefix: "dar_",
} as const;

// ── Sikrets server ────────────────────────────────────────────────────────
// Every vault value goes through a Sikrets server, sealed. Ours by default; a custom one comes from
// --server, SIKRETS_SERVER, "server" in sikrets.json, or the one `sikrets login --server` saved.
export const SERVER = {
  /** The hosted server (placeholder until it is live). */
  defaultUrl: "https://api.sikrets.usetennant.com",
  /** `sikrets server`: port, and data folder under the user dir. */
  localPort: 4873,
  localHost: "127.0.0.1",
  /** The one account on a `sikrets server`. */
  localUser: "you@localhost",
  dataDir: "server",
  /** The environment values go to until environments are exposed in the CLI. */
  environment: "dev",
  /** A server that approves sign-ins itself (`sikrets server`) says so in /v1/info. */
  autoApproval: "auto",
} as const;

// `sikrets mcp`. Output is scrubbed of secret values before it reaches the agent; values shorter
// than minRedactLength aren't scrubbed (they'd match ordinary text) and shouldn't be secrets anyway.
export const MCP = {
  protocolVersion: "2025-11-25",
  defaultTimeoutSeconds: 120,
  maxTimeoutSeconds: 600,
  maxCaptureBytes: 16 * 1024 * 1024,
  maxOutputChars: 60_000,
  minRedactLength: 6,
} as const;

// ── Website logins for agents ─────────────────────────────────────────────
// `sikrets logins` stores website sign-ins; the MCP `login` tool fills them into the agent's
// browser without the agent ever seeing the password or the 2FA code.
export const LOGINS = {
  /** OS keychain service holding each login's username, password and TOTP secret. */
  keychainService: `${KEYCHAIN_SERVICE}.logins`,
  /** Non-secret index under the user dir: login names and origins only. */
  file: "logins.json",
  /** Which agent may use which login without asking again. */
  grantsFile: "login-grants.json",
  /** Chrome the agent and Sikrets share, over the DevTools protocol. */
  cdpEnv: "SIKRETS_BROWSER_CDP",
  defaultCdp: "http://127.0.0.1:9222",
  /** Profile folder (under the user dir's browser/) when Sikrets has to start that Chrome itself. */
  browserProfile: "agent",
  /** Origins that may be stored without https (local test and dev servers). */
  loopbackHosts: ["localhost", "127.0.0.1", "[::1]"],
  unknownAgent: "unknown-agent",
  /** How long to wait for each sign-in step's page to settle, and for the person to answer. */
  stepTimeoutMs: 15_000,
  approvalTimeoutSeconds: 120,
  /** Compiled Touch ID helper, cached under the user dir. */
  touchIdBin: "bin/sikrets-touchid",
  dialogTitle: "Sikrets",
} as const;

// TOTP (RFC 6238) defaults when an otpauth:// URI doesn't say otherwise.
export const TOTP = {
  digits: 6,
  period: 30,
  algorithm: "SHA1",
  algorithms: ["SHA1", "SHA256", "SHA512"],
  scheme: "otpauth:",
} as const;

// ── Password managers ─────────────────────────────────────────────────────
export const PASSWORD_MANAGERS = {
  bitwarden: {
    name: "Bitwarden",
    bin: "bw",
    binEnv: ENV.bw,
    /** Env var the bw CLI reads its unlocked session from. */
    sessionEnv: "BW_SESSION",
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
