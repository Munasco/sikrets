import { readFileSync, renameSync, writeFileSync } from "node:fs";

// The gateway's small JSON files (full access, MCP switches, revoked logins): read once at start,
// written whole through a temp file and a rename, so a crash mid-write leaves the old file intact.

export function load<T>(file: string | undefined, fallback: T): T {
  if (!file) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function save(file: string | undefined, data: unknown) {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Ids that stop counting at a time (a login's cookie expiry), kept in a file and pruned as they pass. */
export class Expiring {
  private items: Map<string, number>;
  constructor(private file?: string) {
    const raw = load<Record<string, number | null> | string[]>(file, {});
    // An older file was a bare list, with no expiry.
    this.items = new Map(Array.isArray(raw) ? raw.map((id) => [id, Infinity]) : Object.entries(raw).map(([id, until]) => [id, until ?? Infinity]));
    this.prune();
  }
  has(id: string | undefined) {
    if (id === undefined) return false;
    const until = this.items.get(id);
    return until !== undefined && until > Date.now();
  }
  add(id: string, until = Infinity) {
    this.items.set(id, until);
    this.prune();
    this.write();
  }
  delete(id: string) {
    if (this.items.delete(id)) this.write();
  }
  private prune() {
    const now = Date.now();
    for (const [id, until] of this.items) if (until <= now) this.items.delete(id);
  }
  private write() {
    // JSON has no Infinity: a login with no expiry (basic auth, local) is stored as null.
    save(this.file, Object.fromEntries([...this.items].map(([id, until]) => [id, Number.isFinite(until) ? until : null])));
  }
}
