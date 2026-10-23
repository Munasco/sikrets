// Fixed values the SDK relies on. Kept in step with packages/cli/src/constants.ts.

export const ENV = { project: "SIKRETS_PROJECT", vault: "SIKRETS_VAULT" } as const;
export const DEFAULT_VAULT = "ssm" as const;
export const DEFAULT_TTL_MS = 5 * 60_000;
export const STAND_IN_PATTERN = /^sk-sikrets-[A-Za-z0-9]{32}$/;
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const SSM_PREFIX = "/sikrets";
export const keychainVaultService = (project: string) => `dev.sikrets.vault.${project}`;
