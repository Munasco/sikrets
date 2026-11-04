// Fixed values the SDK relies on. Kept in step with packages/cli/src/constants.ts.

export const ENV = { project: "SIKRETS_PROJECT", vault: "SIKRETS_VAULT", projectKey: "SIKRETS_PROJECT_KEY" } as const;
export const DEFAULT_VAULT = "ssm" as const;
export const DEFAULT_TTL_MS = 5 * 60_000;
export const STAND_IN_PATTERN = /^sk-sikrets-[A-Za-z0-9]{32}$/;
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const SSM_PREFIX = "/sikrets";
export const keychainVaultService = (project: string) => `dev.sikrets.vault.${project}`;

// Client-side encryption: must match packages/cli/src/constants.ts ENVELOPE byte for byte.
export const ENVELOPE = {
  prefix: "sk1:",
  versionPattern: /^sk(\d+):/,
  hkdfSalt: "sikrets-project-key",
  hkdfInfo: (project: string) => `sikrets-project-v1|${project}`,
  aad: (name: string) => `sikrets-value-v1|${name}`,
  ivBytes: 12,
} as const;
/** Where the CLI keeps the data key (Bun only; deployed apps use SIKRETS_PROJECT_KEY instead). */
export const DATA_KEY_KEYCHAIN = { service: "dev.sikrets.datakey", name: "default" } as const;
