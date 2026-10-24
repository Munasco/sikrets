import type { Resource } from "./state.ts";
import { parseDuration } from "./ttl.ts";

// When a key needs replacing. Rotation is due every `rotateEvery`, but never later than shortly
// before the key's own expiry, so an auto-rotated key is replaced before it lapses.

const DAY = 86_400_000;

/** Checks an --expires value: a duration like 7d, or "never". */
export function parseExpiry(text: string): string {
  if (text !== "never") parseDuration(text);
  return text;
}

/**
 * The lifetime a new key gets: what was asked for, else the longest the provider allows (never,
 * when it has no limit). Returns undefined for a key that doesn't expire.
 */
export function keyExpiry(asked: string | undefined, max: string | undefined, id: string): string | undefined {
  if (max && (asked === "never" || (asked && parseDuration(asked) > parseDuration(max)))) {
    throw new Error(`${id} keys can live at most ${max}; pass --expires ${max} or less`);
  }
  const chosen = asked ?? max;
  return chosen === "never" ? undefined : chosen;
}

export function schedule(rotateEvery: string, expires: string | undefined, now = Date.now()): { rotateBy: string; expiresAt?: string } {
  let rotate = now + parseDuration(rotateEvery);
  if (!expires) return { rotateBy: new Date(rotate).toISOString() };
  const lifetime = parseDuration(expires);
  const expiresAt = now + lifetime;
  // Leave a margin before expiry: a tenth of the key's life, capped at a day.
  rotate = Math.min(rotate, expiresAt - Math.min(DAY, lifetime / 10));
  return { rotateBy: new Date(rotate).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

/** Live resources with auto-rotate on whose rotation date has passed. */
export const autoRotateDue = (resources: readonly Resource[], now = Date.now()) =>
  resources.filter((r) => r.applied && r.autoRotate && r.rotateBy !== undefined && Date.parse(r.rotateBy) <= now);
