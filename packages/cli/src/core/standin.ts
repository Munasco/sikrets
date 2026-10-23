import { recipe } from "../recipes/index.ts";
import { envPrefix } from "../recipes/types.ts";
import { Secret } from "./secret.ts";
import type { Resource } from "./state.ts";
import type { Vault } from "./vault.ts";

// A stand-in is what a project holds instead of a real secret: random, useless against the
// provider, and stable per key. Apps resolve it to the real value with the Sikrets SDK
// (sikrets.get) or by running under `sikrets run`; files, repos and platforms only see stand-ins.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function newStandIn(): Secret {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // 62 * 4 = 248, so taking bytes below 248 keeps every character equally likely.
  const chars = [...bytes].filter((b) => b < 248).map((b) => ALPHABET[b % 62]);
  while (chars.length < 32) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b! < 248) chars.push(ALPHABET[b! % 62]);
  }
  return Secret.of(`sk-sikrets-${chars.join("")}`);
}

export const isStandIn = (value: string) => /^sk-sikrets-[A-Za-z0-9]{32}$/.test(value);

/** Vault key holding the stand-in for a real key. */
export const standInKey = (key: string) => `SIKRETS_STANDIN__${key}`;

export interface OutputKey {
  key: string;
  sensitive: boolean;
}

export function outputKeys(res: Resource): OutputKey[] {
  return Object.values(recipe(res.recipe).outputs).map((o) => ({ key: `${envPrefix(res.name)}_${o.env}`, sensitive: o.sensitive }));
}

/** The stand-in for `key`, created and stored the first time it's needed, then always the same. */
export async function standInFor(vault: Vault, key: string): Promise<Secret> {
  const existing = await vault.get(standInKey(key));
  if (existing) return existing;
  const fresh = newStandIn();
  await vault.put(standInKey(key), fresh);
  return fresh;
}

/** What a project's env file gets: stand-ins for secrets (unless `real`), real values for the rest. */
export async function envValues(vault: Vault, resources: readonly Resource[], real: boolean): Promise<Map<string, Secret>> {
  const out = new Map<string, Secret>();
  for (const res of resources.filter((r) => r.applied)) {
    for (const { key, sensitive } of outputKeys(res)) {
      if (sensitive && !real) out.set(key, await standInFor(vault, key));
      else {
        const value = await vault.get(key);
        if (value) out.set(key, value);
      }
    }
  }
  return out;
}
