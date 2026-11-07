import type { Secret } from "../core/secret.ts";

// A password manager Sikrets layers on top of: the user's vault stays where it is, and Sikrets
// reads from it, writes rotated values back to it and imports from it. Each adapter drives the
// manager's own CLI, so whatever unlock, 2FA and sync rules that CLI has still apply.

export type ManagerId = "bitwarden" | "1password";

/** One secret field of one item, as `list()` returns it. */
export interface ManagerEntry {
  /** Reference that `read`/`write` accept, e.g. bw://<item id>/password or op://Dev/Stripe/credential. */
  ref: string;
  item: string;
  field: string;
  value: Secret;
}

export interface UnlockOptions {
  /** Self-hosted server (Vaultwarden), Bitwarden only. */
  server?: string;
  email?: string;
  password: () => Promise<Secret>;
  say: (m: string) => void;
}

/**
 * Whether Sikrets can use the manager right now, checked against its CLI.
 * - unauthenticated: the CLI isn't signed in to any account
 * - locked: signed in, but Sikrets holds no session (never unlocked here, or locked)
 * - expired: Sikrets holds a session the CLI no longer accepts (locked or signed out elsewhere)
 * - unlocked: ready
 */
export type ManagerStatus =
  | { state: "unauthenticated" }
  | { state: "locked"; account?: string }
  | { state: "expired"; account: string }
  | { state: "unlocked"; account: string };

/** What to tell the user for a status that isn't unlocked. */
export function statusMessage(name: string, unlock: string, s: Exclude<ManagerStatus, { state: "unlocked" }>): string {
  switch (s.state) {
    case "unauthenticated":
      return `${name} isn't signed in. Run: sikrets unlock ${unlock}`;
    case "locked":
      return `${name} is locked. Run: sikrets unlock ${unlock}`;
    case "expired":
      return `Your ${name} session for ${s.account} expired (locked or signed out elsewhere). Run: sikrets unlock ${unlock}`;
  }
}

export interface PasswordManager {
  id: ManagerId;
  name: string;
  /** True if `ref` points into this manager. */
  owns(ref: string): boolean;
  read(ref: string): Promise<Secret>;
  write(ref: string, value: Secret): Promise<void>;
  list(): Promise<ManagerEntry[]>;
  /** Signs in or unlocks, and keeps the session in the OS keychain. Returns the account. */
  unlock(opts: UnlockOptions): Promise<string>;
  /** Locks the CLI, forgets the session and the connection record, so nothing uses it until unlocked again. */
  lock(): Promise<void>;
  status(): Promise<ManagerStatus>;
}
