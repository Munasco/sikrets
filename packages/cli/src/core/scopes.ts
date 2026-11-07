import { redact, type Secret } from "./secret.ts";
import { GITHUB, SCOPES, USER_AGENT } from "../constants.ts";

// Over-scope checks, only where the provider makes them cheap: a key prefix, or one read-only
// request. Keys of other kinds return undefined (not checked), never a guess.

export interface ScopeFinding {
  provider: "github" | "stripe";
  overScoped: boolean;
  /** Scope names or a plain explanation; never any part of the key. */
  detail: string;
}

const startsWithAny = (value: string, prefixes: readonly string[]) => prefixes.some((p) => value.startsWith(p));

export async function checkScope(key: Secret, opts: { offline?: boolean } = {}): Promise<ScopeFinding | undefined> {
  const value = key.reveal();
  if (startsWithAny(value, SCOPES.stripe.secretPrefixes)) return { provider: "stripe", overScoped: true, detail: "secret key with full account access; use a restricted key (rk_)" };
  if (startsWithAny(value, SCOPES.stripe.restrictedPrefixes)) return { provider: "stripe", overScoped: false, detail: "restricted key" };
  if (startsWithAny(value, SCOPES.github.classicPrefixes)) return opts.offline ? undefined : githubScopes(key);
  return undefined;
}

/** Classic GitHub tokens list their scopes in X-OAuth-Scopes on any authenticated response. */
async function githubScopes(key: Secret): Promise<ScopeFinding> {
  try {
    const res = await fetch(`${GITHUB.api}/user`, {
      headers: { Authorization: `Bearer ${key.reveal()}`, Accept: GITHUB.accept, "X-GitHub-Api-Version": GITHUB.apiVersion, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { provider: "github", overScoped: false, detail: "GitHub rejected it (revoked or expired?)" };
    const header = res.headers.get(SCOPES.github.header);
    if (header === null) return { provider: "github", overScoped: false, detail: `scopes not reported (HTTP ${res.status})` };
    const scopes = header.split(",").map((s) => s.trim()).filter(Boolean);
    const broad = scopes.filter((s) => (SCOPES.github.broad as readonly string[]).includes(s));
    return broad.length
      ? { provider: "github", overScoped: true, detail: `broad scopes: ${broad.join(", ")}` }
      : { provider: "github", overScoped: false, detail: scopes.length ? `scopes: ${scopes.join(", ")}` : "no scopes" };
  } catch (error) {
    return { provider: "github", overScoped: false, detail: `couldn't check: ${redact(error instanceof Error ? error.message : String(error), [key])}` };
  }
}
