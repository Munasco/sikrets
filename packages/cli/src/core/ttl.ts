// Durations like "30m", "24h", "7d". Strict, so "24" or "1 day" fail instead of meaning something odd.
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(text: string): number {
  const m = /^(\d{1,4})([mhd])$/.exec(text.trim());
  if (!m || Number(m[1]) === 0) throw new Error(`"${text}" must be a duration like 30m, 24h or 30d`);
  return Number(m[1]) * UNITS[m[2] as keyof typeof UNITS];
}

export const after = (duration: string, from = Date.now()) => new Date(from + parseDuration(duration)).toISOString();

/** "in 6d", "in 3h", "overdue by 2d". */
export function until(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const text = abs >= UNITS.d ? `${Math.round(abs / UNITS.d)}d` : abs >= UNITS.h ? `${Math.round(abs / UNITS.h)}h` : `${Math.max(1, Math.round(abs / UNITS.m))}m`;
  return ms >= 0 ? `in ${text}` : `overdue by ${text}`;
}
