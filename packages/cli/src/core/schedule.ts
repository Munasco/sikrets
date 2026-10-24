import type { Resource } from "./state.ts";
import { parseDuration, until } from "./ttl.ts";

// When credentials need attention. Rotation is due every `rotateEvery`, but never later than
// shortly before a key's own expiry, so a key Sikrets can't rotate on its own is replaced before
// it lapses.

/** Expiry choices a provider offers at creation (Anthropic: 3 hours to 30 days, or never). */
export const EXPIRY_CHOICES = ["3h", "1d", "7d", "30d", "never"] as const;

const DAY = 86_400_000;

export function schedule(rotateEvery: string, expires: string | undefined, now = Date.now()): { rotateBy: string; expiresAt?: string } {
  let rotate = now + parseDuration(rotateEvery);
  if (!expires || expires === "never") return { rotateBy: new Date(rotate).toISOString() };
  const lifetime = parseDuration(expires);
  const expiresAt = now + lifetime;
  // Leave a margin before expiry: a tenth of the key's life, capped at a day.
  rotate = Math.min(rotate, expiresAt - Math.min(DAY, lifetime / 10));
  return { rotateBy: new Date(rotate).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}

export type DueKind = "expired" | "rotate-overdue" | "expires-soon" | "rotate-soon";

export interface Due {
  name: string;
  kind: DueKind;
  at: string;
}

/** Live resources that are past due, or due within `soonMs` (default 7 days), most urgent first. */
export function dueList(resources: readonly Resource[], now = Date.now(), soonMs = 7 * DAY): Due[] {
  const out: Due[] = [];
  for (const r of resources.filter((x) => x.applied)) {
    const exp = r.expiresAt ? Date.parse(r.expiresAt) : undefined;
    const rot = r.rotateBy ? Date.parse(r.rotateBy) : undefined;
    if (exp !== undefined && exp <= now) out.push({ name: r.name, kind: "expired", at: r.expiresAt! });
    else if (rot !== undefined && rot <= now) out.push({ name: r.name, kind: "rotate-overdue", at: r.rotateBy! });
    else if (exp !== undefined && exp - now <= soonMs) out.push({ name: r.name, kind: "expires-soon", at: r.expiresAt! });
    else if (rot !== undefined && rot - now <= soonMs) out.push({ name: r.name, kind: "rotate-soon", at: r.rotateBy! });
  }
  const order: DueKind[] = ["expired", "rotate-overdue", "expires-soon", "rotate-soon"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.at.localeCompare(b.at));
}

export function describeDue(d: Due, now = Date.now()): string {
  switch (d.kind) {
    case "expired":
      return `${d.name}: key expired ${until(d.at, now).replace("overdue by", "")} ago`.replace("  ", " ");
    case "rotate-overdue":
      return `${d.name}: rotation ${until(d.at, now)}`;
    case "expires-soon":
      return `${d.name}: key expires ${until(d.at, now)}`;
    case "rotate-soon":
      return `${d.name}: rotation due ${until(d.at, now)}`;
  }
}
