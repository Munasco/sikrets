import path from "node:path";
import { readJson, writeJson } from "./fs.ts";
import type { Context } from "./plan.ts";
import { parseDuration } from "./ttl.ts";
import { VAULT_NAMES, type VaultName } from "./vault.ts";
import { DEFAULTS, ENCRYPTION_REQUIRED, ENV, FILES, IAC_DIR, SCHEMA_URL } from "../constants.ts";

// sikrets.json: the committed, hand-editable project file (like vercel.json). Machine-written
// state stays in .sikrets/. Validation is strict so a typo fails loudly instead of being ignored.

export interface ProjectConfig {
  readonly $schema?: string;
  /** Vault namespace and SDK project name. Defaults to the directory name. */
  readonly project: string;
  readonly vault: VaultName;
  /** Env file that `add` and `env pull` write. */
  readonly env: string;
  readonly iac: { readonly tool: "terraform"; readonly dir: string };
  /** Which named connection to use per provider when there are several. */
  readonly connections: Readonly<Record<string, string>>;
  /** How often provisioned credentials should be rotated, e.g. "30d". */
  readonly rotateEvery: string;
  /**
   * "required" once every value is sealed (set by `init` and `migrate encrypt`): a plaintext value
   * in the vault is then refused rather than trusted. Absent on older projects, which still read
   * legacy plaintext until they're migrated.
   */
  readonly encryption?: typeof ENCRYPTION_REQUIRED;
}

export const CONFIG_FILE = FILES.config;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEYS = ["$schema", "project", "vault", "env", "iac", "connections", "rotateEvery", "encryption"] as const;

export const defaultConfig = (root: string): ProjectConfig => ({
  $schema: SCHEMA_URL,
  project: path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "") || "project",
  vault: DEFAULTS.vault,
  env: DEFAULTS.envFile,
  iac: { tool: "terraform", dir: IAC_DIR },
  connections: {},
  rotateEvery: DEFAULTS.rotateEvery,
});

function fail(message: string): never {
  throw new Error(`${CONFIG_FILE}: ${message}`);
}

export function validateConfig(raw: unknown, root: string): ProjectConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("expected an object");
  const unknown = Object.keys(raw).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (unknown.length) fail(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
  const c = { ...defaultConfig(root), ...(raw as Partial<ProjectConfig>) };
  if (typeof c.project !== "string" || !PROJECT.test(c.project)) fail(`"project" must be lowercase letters, digits and dashes`);
  if (!VAULT_NAMES.includes(c.vault)) fail(`"vault" must be one of ${VAULT_NAMES.join(", ")}`);
  if (typeof c.env !== "string" || !c.env || path.isAbsolute(c.env) || c.env.split(/[\\/]/).includes("..")) fail(`"env" must be a relative path inside the project`);
  if (c.iac?.tool !== "terraform" || typeof c.iac.dir !== "string" || path.isAbsolute(c.iac.dir)) fail(`"iac" must be { "tool": "terraform", "dir": "<relative dir>" }`);
  if (typeof c.connections !== "object" || c.connections === null || Object.values(c.connections).some((v) => typeof v !== "string")) {
    fail(`"connections" must map provider ids to connection names`);
  }
  if (c.encryption !== undefined && c.encryption !== ENCRYPTION_REQUIRED) fail(`"encryption" can only be "${ENCRYPTION_REQUIRED}"`);
  try {
    parseDuration(c.rotateEvery);
  } catch {
    fail(`"rotateEvery" must be a duration like 7d or 30d`);
  }
  return c;
}

export async function loadConfig(root: string): Promise<ProjectConfig> {
  const raw = await readJson<unknown>(path.join(root, CONFIG_FILE), undefined);
  return raw === undefined ? defaultConfig(root) : validateConfig(raw, root);
}

export async function hasConfig(root: string): Promise<boolean> {
  return Bun.file(path.join(root, CONFIG_FILE)).exists();
}

export const writeConfig = (root: string, config: ProjectConfig) => writeJson(path.join(root, CONFIG_FILE), config);

/** SIKRETS_VAULT overrides the project's vault for one run (e.g. keychain for local experiments). */
export function effectiveVault(config: ProjectConfig): VaultName {
  const override = Bun.env[ENV.vault];
  if (override === undefined) return config.vault;
  if (!(VAULT_NAMES as readonly string[]).includes(override)) throw new Error(`${ENV.vault} must be one of ${VAULT_NAMES.join(", ")}, not "${override}"`);
  return override as VaultName;
}

/** Everything a command needs about the project in the current directory. */
export async function projectContext(root: string, opts: { dryRun?: boolean; log: (m: string) => void }): Promise<{ config: ProjectConfig; ctx: Context }> {
  const config = await loadConfig(root);
  const ctx = { root, project: config.project, vault: effectiveVault(config), requireSealed: config.encryption === ENCRYPTION_REQUIRED, dryRun: opts.dryRun ?? false, log: opts.log };
  return { config, ctx };
}
