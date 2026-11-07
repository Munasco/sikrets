// Fixed values the SDK relies on. Kept in step with packages/cli/src/constants.ts.

export const ENV = { project: "SIKRETS_PROJECT", vault: "SIKRETS_VAULT", projectKey: "SIKRETS_PROJECT_KEY", server: "SIKRETS_SERVER" } as const;
export const DEFAULT_VAULT = "ssm" as const;
export const DEFAULT_TTL_MS = 5 * 60_000;
export const STAND_IN_PATTERN = /^sk-sikrets-[A-Za-z0-9]{32}$/;
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const SSM_PREFIX = "/sikrets";
export const keychainVaultService = (project: string) => `dev.sikrets.vault.${project}`;
/** Keychain slot where CLIs before device keys kept the raw data key (deployed apps use SIKRETS_PROJECT_KEY). */
export const DATA_KEY = { service: "dev.sikrets.datakey", name: "default" } as const;
/** The per-user folder the CLI writes (packages/cli/src/constants.ts ENV.configDir, USER_DIR). */
export const CONFIG_DIR_ENV = "SIKRETS_CONFIG_DIR";
export const USER_DIR = ".sikrets";
/** Where the CLI keeps the data key wrapped to this device, and how it wraps it (CLI DEVICE). */
export const DEVICE = {
  dir: "device",
  metaFile: "device.json",
  agreementKey: "agreement.key",
  signingKey: "signing.key",
  sessionFile: "session.json",
  dataKeyFile: "datakey.json",
  /** Stable link to the CLI's compiled Secure Enclave helper, relative to the user folder. */
  helper: "bin/sikrets-device",
  wrapSalt: "sikrets-datakey-wrap",
  wrapInfo: "sikrets-datakey-wrap-v1",
  wrapAad: "sikrets-datakey-v1",
  thumbprintChars: 16,
} as const;
/** Client-side encryption: the same envelope the CLI writes (packages/cli/src/constants.ts ENVELOPE). */
export const ENVELOPE = {
  prefix: "sk1:",
  versionPattern: /^sk(\d+):/,
  hkdfSalt: "sikrets-project-key",
  hkdfInfo: (project: string) => `sikrets-project-v1|${project}`,
  aad: (project: string, key: string) => `sikrets-value-v1|${SSM_PREFIX}/${project}/${key}`,
  ivBytes: 12,
  tagBytes: 16,
} as const;

/** The Sikrets server's API, as the CLI speaks it (packages/cli/src/constants.ts DEVICE_AUTH, SERVER). */
export const SERVER_API = {
  configFile: "sikrets.json",
  environment: "dev",
  value: (project: string, environment: string, name: string) => `/v1/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/values/${encodeURIComponent(name)}`,
  proofHeader: "sikrets-device-proof",
  proofType: "sikrets-device-proof+jwt",
  alg: "ES256",
  nonceBytes: 16,
} as const;
