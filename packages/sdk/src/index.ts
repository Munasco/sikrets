// Sikrets SDK. Projects keep stand-ins (sk-sikrets-…) in .env and on hosting platforms; the app
// asks for the real value at runtime:
//
//   import { sikrets } from "@sikrets/sdk";
//   const anthropic = new Anthropic({ apiKey: await sikrets.get("ANTHROPIC_API_KEY") });
//
// Resolution, in order:
//   1. The environment already holds the real value (under `sikrets run`, or injected in prod) → use it.
//   2. It holds a stand-in, or nothing → fetch the real value from the project's vault with the
//      app's own credentials (an IAM role in production, your AWS profile locally).
// Values are cached briefly so a rotated key is picked up without a restart.

import { DEFAULT_TTL_MS, DEFAULT_VAULT, ENV, KEY_PATTERN, keychainVaultService, SSM_PREFIX, STAND_IN_PATTERN } from "./constants.ts";

export type VaultName = "ssm" | "keychain";

export interface SikretsOptions {
  /** Project name used for vault paths; defaults to SIKRETS_PROJECT, then the working directory's name. */
  readonly project?: string;
  /** Vault backend; defaults to SIKRETS_VAULT, then "ssm". */
  readonly vault?: VaultName;
  /** How long a fetched value is reused before asking the vault again. Default 5 minutes. */
  readonly ttlMs?: number;
  /** Environment to read; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces the vault lookup (tests, custom backends). Returns undefined when the key doesn't exist. */
  readonly fetch?: (project: string, key: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

export type SikretsErrorCode = "invalid-key" | "not-found" | "vault";

export class SikretsError extends Error {
  constructor(
    readonly code: SikretsErrorCode,
    readonly key: string,
    message: string,
  ) {
    super(`sikrets: ${key}: ${message}`);
  }
}

export interface Sikrets {
  /** The real value of `key`. Throws SikretsError if it can't be resolved; never returns a stand-in. */
  get(key: string): Promise<string>;
  /** Several keys at once, fetched in parallel. */
  getAll<K extends string>(keys: readonly K[]): Promise<Record<K, string>>;
  /** Drops cached values, e.g. after a rotation you triggered yourself. */
  clear(): void;
}

export const isStandIn = (value: string) => STAND_IN_PATTERN.test(value);

function defaultProject(env: SikretsOptions["env"]): string {
  const named = env?.[ENV.project];
  if (named) return named;
  const cwd = typeof process !== "undefined" ? process.cwd() : "";
  const name = cwd.split(/[\\/]/).filter(Boolean).at(-1);
  if (!name) throw new Error(`sikrets: set ${ENV.project} so the SDK knows which project's vault to read`);
  return name;
}

function vaultFetch(name: VaultName): (project: string, key: string) => Promise<string | undefined> {
  if (name === "keychain") {
    return async (project, key) => {
      const bun = (globalThis as { Bun?: { secrets: { get(o: { service: string; name: string }): Promise<string | null> } } }).Bun;
      if (!bun) throw new Error("the keychain vault needs Bun; use the ssm vault under Node");
      return (await bun.secrets.get({ service: keychainVaultService(project), name: key })) ?? undefined;
    };
  }
  let client: Promise<{ get(path: string): Promise<string | undefined> }> | undefined;
  const ssm = () =>
    (client ??= (async () => {
      const { SSMClient, GetParameterCommand, ParameterNotFound } = await import("@aws-sdk/client-ssm").catch(() => {
        throw new Error("install @aws-sdk/client-ssm to read the ssm vault");
      });
      const c = new SSMClient({});
      return {
        async get(path: string) {
          try {
            return (await c.send(new GetParameterCommand({ Name: path, WithDecryption: true }))).Parameter?.Value;
          } catch (error) {
            if (error instanceof ParameterNotFound) return undefined;
            throw error;
          }
        },
      };
    })());
  return async (project, key) => (await ssm()).get(`${SSM_PREFIX}/${project}/${key}`);
}

export function createSikrets(opts: SikretsOptions = {}): Sikrets {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const vault = (opts.vault ?? (env[ENV.vault] as VaultName | undefined) ?? DEFAULT_VAULT) satisfies VaultName;
  const fetchValue = opts.fetch ?? vaultFetch(vault);
  let project: string | undefined = opts.project;
  const cache = new Map<string, { value: string; until: number }>();
  const inflight = new Map<string, Promise<string>>();

  async function resolve(key: string): Promise<string> {
    const present = env[key];
    if (present && !isStandIn(present)) return present;

    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;

    let value: string | undefined;
    try {
      value = await fetchValue((project ??= defaultProject(env)), key);
    } catch (error) {
      // Backend errors describe permissions or connectivity; they don't contain secret values.
      throw new SikretsError("vault", key, error instanceof Error ? error.message : "vault unavailable");
    }
    if (!value) throw new SikretsError("not-found", key, `not in the ${opts.fetch ? "configured" : vault} vault for project "${project}"`);
    if (isStandIn(value)) throw new SikretsError("vault", key, "the vault returned a stand-in instead of a real value");
    cache.set(key, { value, until: now() + ttl });
    return value;
  }

  return {
    get(key) {
      if (!KEY_PATTERN.test(key)) return Promise.reject(new SikretsError("invalid-key", key, "keys are UPPER_SNAKE_CASE"));
      // Concurrent callers for the same key share one vault request.
      let pending = inflight.get(key);
      if (!pending) {
        pending = resolve(key).finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return pending;
    },
    async getAll(keys) {
      const values = await Promise.all(keys.map((k) => this.get(k)));
      return Object.fromEntries(keys.map((k, i) => [k, values[i]!])) as Record<(typeof keys)[number], string>;
    },
    clear: () => cache.clear(),
  };
}

/** Default client: reads process.env, SIKRETS_PROJECT and SIKRETS_VAULT. */
export const sikrets: Sikrets = createSikrets();
