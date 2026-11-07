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

// Cross-process lock on a shared file (`<file>.lock`): how long to wait for it, how often to retry,
// and when a lock whose holder never released it is treated as stale.
export const FILE_LOCK = {
  suffix: ".lock",
  waitMs: 10_000,
  retryMs: 20,
  staleMs: 30_000,
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

// `sikrets mcp`. Output is scrubbed of secret values before it reaches the agent; values shorter
// than minRedactLength aren't scrubbed (they'd match ordinary text) and shouldn't be secrets anyway.
export const MCP = {
  protocolVersion: "2025-11-25",
  defaultTimeoutSeconds: 120,
  maxTimeoutSeconds: 600,
  maxCaptureBytes: 16 * 1024 * 1024,
  maxOutputChars: 60_000,
  minRedactLength: 6,
  // Stopping a command: SIGTERM to its process group, SIGKILL after killGraceMs, and stop reading
  // its pipes readDeadlineMs after that (a process that left the group can still hold them open).
  killGraceMs: 2_000,
  readDeadlineMs: 1_000,
} as const;

// `sikrets mcp --http`: the same server over Streamable HTTP, for apps that can't spawn a local
// process. Every client is an agent with its own bearer token (or OAuth grant); only hashes are on
// disk, and the bearer token itself lives in the keychain.
export const MCP_HTTP = {
  defaultHost: "127.0.0.1",
  defaultPort: 7787,
  path: "/mcp",
  loopbackHosts: ["127.0.0.1", "localhost", "::1", "[::1]"],
  /** Client registry under the user dir: names, token hashes, OAuth registrations. Never a token. */
  clientsFile: "mcp-clients.json",
  /** OS keychain service holding each bearer client's token, so `sikrets mcp clients token` can hand it over again. */
  keychainService: `${KEYCHAIN_SERVICE}.mcp`,
  /** Env var the printed config snippets read the token from; snippets never contain a token. */
  tokenEnv: "SIKRETS_MCP_TOKEN",
  tokenPrefix: { bearer: "sik_mcp_", access: "sik_at_", refresh: "sik_rt_", code: "sik_ac_", clientSecret: "sik_cs_" },
  tokenBytes: 32,
  clientName: /^[a-z0-9][a-z0-9._-]{0,47}$/,
  maxBodyBytes: 1024 * 1024,
  /** Requests per client: a bucket of `burst` refilled at `perMinute`. */
  rateLimit: { perMinute: 120, burst: 30 },
  /** Bad or missing tokens tolerated per remote address before 429s. */
  authFailures: { perMinute: 10, burst: 10 },
  /** OAuth sign-ups and approval prompts, across everyone (they open a dialog on your screen). */
  oauthPrompts: { perMinute: 3, burst: 3 },
  /** SSE comment sent while a long tool call runs, so tunnels and proxies keep the request open. */
  keepAliveMs: 15_000,
  oauth: {
    codeTtlSeconds: 60,
    accessTtlSeconds: 60 * 60,
    refreshTtlSeconds: 30 * 24 * 60 * 60,
    maxRegistrations: 50,
    scopes: ["sikrets", "offline_access"],
  },
} as const;

// Where each app keeps its MCP config, for `sikrets mcp config|install <app>`. "~" is the home folder.
export const MCP_APPS = {
  serverName: "sikrets",
  claudeDesktopConfig: {
    darwin: "~/Library/Application Support/Claude/claude_desktop_config.json",
    win32: "%APPDATA%\\Claude\\claude_desktop_config.json",
    linux: "~/.config/Claude/claude_desktop_config.json",
  },
  cursorConfig: "~/.cursor/mcp.json",
  windsurfConfig: "~/.codeium/windsurf/mcp_config.json",
  geminiConfig: "~/.gemini/settings.json",
  antigravityConfig: "~/.gemini/config/mcp_config.json",
  zedConfig: "~/.config/zed/settings.json",
  codexConfig: "~/.codex/config.toml",
  vscodeConfig: ".vscode/mcp.json",
  claudeCodeConfig: ".mcp.json",
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
  /** How long to wait for the DevTools endpoint to answer before calling it unresponsive. */
  cdpProbeMs: 3_000,
  /** Profile folder (under the user dir's browser/) when Sikrets has to start that Chrome itself. */
  browserProfile: "agent",
  /** Origins that may be stored without https (local test and dev servers). */
  loopbackHosts: ["localhost", "127.0.0.1", "[::1]"],
  unknownAgent: "unknown-agent",
  /** Programs that only start the agent's MCP server; the agent is whatever started them. */
  launchers: ["sh", "bash", "zsh", "dash", "fish", "env", "npx", "npm", "bunx", "pnpm", "pnpx", "yarn", "uvx"],
  maxLauncherHops: 6,
  /** How long to wait for each sign-in step's page to settle, and for the person to answer. */
  stepTimeoutMs: 15_000,
  approvalTimeoutSeconds: 120,
  /** Compiled Touch ID helper, cached under the user dir. */
  touchIdBin: "bin/sikrets-touchid",
  /** Keychain entry (under keychainService) pinning the helper's SHA-256, checked before every run. */
  touchIdPin: "touchid-helper-sha256",
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
