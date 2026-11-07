import { bitwarden } from "./bitwarden.ts";
import { onepassword } from "./onepassword.ts";
import type { PasswordManager } from "./types.ts";

export const managers: Record<string, PasswordManager> = { bitwarden, vaultwarden: bitwarden, "1password": onepassword, op: onepassword, bw: bitwarden };

export function manager(id: string): PasswordManager {
  const m = managers[id.toLowerCase()];
  if (!m) throw new Error(`Unknown password manager "${id}". Available: bitwarden (or vaultwarden), 1password`);
  return m;
}

export function managerFor(ref: string): PasswordManager {
  const m = [bitwarden, onepassword].find((x) => x.owns(ref));
  if (!m) throw new Error(`"${ref}" isn't a password manager reference. Use bw://<item id>/<field> or op://<vault>/<item>/<field>`);
  return m;
}
