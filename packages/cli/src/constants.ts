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
  /** Overrides the project's vault for one run: "ssm", "keychain" or "aws". */
  vault: "SIKRETS_VAULT",
  /** Terraform-compatible binary to use instead of terraform/tofu on PATH. */
  terraform: "SIKRETS_TERRAFORM",
  /** Project name for the SDK when it can't infer one. */
  project: "SIKRETS_PROJECT",
  /** Agent a command hands keys to (same as --agent); see `sikrets agent`. */
  agent: "SIKRETS_AGENT",
  /** S3 URL of the published stack template, for `sikrets cloud connect --link`. */
  stackTemplateUrl: "SIKRETS_STACK_TEMPLATE_URL",
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
  agents: "agents.json",
} as const;
/** Folder under the user dir for per-project usage logs (local only, never in the project). */
export const USAGE_DIR = "usage";
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

// ── Self-hosted Sikrets in your cloud account (src/cloud) ────────────────
export const CLOUD = {
  defaultProvider: "aws",
} as const;

// ── Sikrets stack in your AWS account (packages/stack/sikrets.yaml) ───────
export const AWS_STACK = {
  defaultName: "sikrets",
  /** CloudFormation template parameters, by name. */
  params: {
    vaultPath: "VaultPath",
    agentRolePath: "AgentRolePath",
    githubRepository: "GitHubRepository",
    createGitHubProvider: "CreateGitHubOidcProvider",
    trustedAccount: "TrustedAccountId",
    externalId: "ExternalId",
  },
  /** CloudFormation template outputs, by name. */
  outputs: {
    key: "KeyArn",
    vaultPath: "VaultPath",
    boundary: "AgentBoundaryArn",
    managerPolicy: "AgentManagerPolicyArn",
    agentRolePath: "AgentRolePath",
    eventBus: "EventBusName",
    eventBusArn: "EventBusArn",
    auditLogGroup: "AuditLogGroupName",
    brokerRole: "BrokerRoleArn",
    githubRole: "GitHubActionsRoleArn",
  },
  /** The template names the GitHub Actions role, so CloudFormation needs the named-IAM acknowledgement. */
  capabilities: ["CAPABILITY_NAMED_IAM"],
  /** Stack tags (also on the resources CloudFormation creates). */
  managedByTag: "sikrets:managed-by",
  /** Where the stack's outputs are recorded, under the user dir. No secrets. */
  stateFile: "aws-stack.json",
  /** Keychain account (under the aws provider) holding the optional broker's external ID. */
  externalIdAccount: (region: string, stack: string) => `external-id:${region}:${stack}`,
  externalIdBytes: 24,
  /** `--trust-account none` turns the cross-account broker off again. */
  noBroker: "none",
  pollMs: 5_000,
  timeoutMs: 30 * 60_000,
  quickCreate: (region: string) => `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate`,
} as const;

export const AGENT_ROLE = {
  path: "/sikrets/agents/",
  namePrefix: "sikrets-agent-",
  /** Every agent role is tagged sikrets:agent=<name>; the manager policy refuses to create one without it. */
  tag: "sikrets:agent",
  /** Inline policies: the vault secrets in the agent's scope, and extra AWS actions from --allow. */
  vaultPolicy: "sikrets-vault",
  allowPolicy: "sikrets-allow",
  maxSessionSeconds: 3600,
  defaultTtl: "15m",
  sessionName: (agent: string) => `sikrets-${agent}`,
  /** The agent role the stack creates for GitHub Actions when GitHubRepository is set. */
  githubAgent: "github-actions",
  /** Services the boundary denies outright; refused up front with a clearer message. */
  deniedServices: ["iam", "sts", "organizations", "account", "sso", "identitystore"],
  /** A new role can take a few seconds to become assumable. */
  assumeRetries: 6,
  assumeRetryMs: 2_000,
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
