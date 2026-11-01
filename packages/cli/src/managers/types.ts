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
  lock(): Promise<void>;
}
