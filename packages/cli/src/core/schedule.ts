import { recipe } from "../recipes/index.ts";
import type { Resource } from "./state.ts";
import { parseDuration } from "./ttl.ts";
import { AUTO_ROTATE_BACKOFF_MS } from "../constants.ts";

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
 * when it has no limit). Returns undefined for a key that doesn't expire. Only keys a person
 * creates in a dashboard can be given a lifetime: there --expires records what they picked. Sikrets
 * can't ask a provider's API for an expiry, so an API key's is the provider's own limit.
 */
export function keyExpiry(asked: string | undefined, max: string | undefined, id: string, chosenByPerson = true): string | undefined {
  if (asked && !chosenByPerson) throw new Error(`${id} keys can't be given an expiry by Sikrets${max ? ` (the provider caps them at ${max})` : " (they don't expire)"}; drop --expires and use rotateEvery or --auto-rotate`);
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

/**
 * When a resource's current key should be replaced, from when it was issued and sikrets.json's
 * current rotateEvery (so changing rotateEvery reschedules every key). Terraform keys: never.
 */
export function dueAt(r: Resource, rotateEvery: string): string | undefined {
  if (r.strategy === "terraform") return undefined;
  return schedule(rotateEvery, r.expires, Date.parse(r.lastRotatedAt ?? r.createdAt)).rotateBy;
}

/** Only API keys with a rotate call can rotate without a person, whatever state.json says. */
const canAutoRotate = (r: Resource) => {
  const rec = recipe(r.recipe);
  return r.strategy === "api" && rec.strategy === "api" && rec.rotate !== undefined;
};

/**
 * Live, auto-rotating resources that are due, or whose last rotation stopped with the new key saved
 * locally (resuming that calls no provider). One whose provider call had an unknown outcome is
 * retried only after a back-off, so a failing vault can't make every command revoke the key again.
 */
export function autoRotateDue(resources: readonly Resource[], rotateEvery: string, now = Date.now()): Resource[] {
  return resources.filter((r) => {
    if (!r.applied || !r.autoRotate || !canAutoRotate(r)) return false;
    if (r.rotation?.status === "issued") return true;
    if (r.rotation?.status === "requested" && now - Date.parse(r.rotation.at) < AUTO_ROTATE_BACKOFF_MS) return false;
    const due = dueAt(r, rotateEvery);
    return due !== undefined && Date.parse(due) <= now;
  });
}
