import path from "node:path";
import { readJson, updateJson } from "../fs.ts";
import { Secret } from "../secret.ts";
import { configDir } from "../../store.ts";
import { LOGINS } from "../../constants.ts";
import { loginOrigin } from "./origin.ts";
import { parseTotp } from "./totp.ts";

// Website logins. The values (username, password, TOTP secret) live in the OS keychain as one
// entry per login; ~/.sikrets/logins.json keeps only what's safe to show: name, origin, whether a
// TOTP secret is stored, and when it was added. Values leave this module only wrapped in Secret.

export interface LoginInfo {
  readonly name: string;
  readonly origin: string;
  readonly totp: boolean;
  readonly addedAt: string;
}

export interface Login extends LoginInfo {
  readonly username: Secret;
  readonly password: Secret;
  readonly totpSecret?: Secret;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export function checkName(name: string) {
  if (!NAME.test(name)) throw new Error(`Login names are lowercase letters, digits, ".", "_" and "-" (got "${name}")`);
  return name;
}

const indexFile = () => path.join(configDir(), LOGINS.file);
const keychain = {
  set: (name: string, value: string) => Bun.secrets.set({ service: LOGINS.keychainService, name, value }),
  get: (name: string) => Bun.secrets.get({ service: LOGINS.keychainService, name }),
  delete: (name: string) => Bun.secrets.delete({ service: LOGINS.keychainService, name }),
};

export const listLogins = () => readJson<LoginInfo[]>(indexFile(), []);

// The index is changed under its lock. Order keeps a crash harmless: the keychain entry is
// written before the index names it and deleted after the index forgets it, so the worst left
// behind is an unlisted keychain entry, overwritten when the name is added again.
const updateIndex = (fn: (all: LoginInfo[]) => LoginInfo[] | undefined) =>
  updateJson<LoginInfo[]>(indexFile(), [], (all) => fn(all)?.sort((a, b) => a.name.localeCompare(b.name)));

export async function addLogin(input: { name: string; url: string; username: Secret; password: Secret; totpSecret?: Secret }): Promise<LoginInfo> {
  const name = checkName(input.name);
  const origin = loginOrigin(input.url);
  if (input.totpSecret) parseTotp(input.totpSecret); // reject a bad secret now, not mid-login
  const info: LoginInfo = { name, origin, totp: Boolean(input.totpSecret), addedAt: new Date().toISOString() };
  await keychain.set(
    name,
    JSON.stringify({ username: input.username.reveal(), password: input.password.reveal(), ...(input.totpSecret ? { totp: input.totpSecret.reveal() } : {}) }),
  );
  await updateIndex((all) => [...all.filter((l) => l.name !== name), info]);
  return info;
}

export async function getLogin(name: string): Promise<Login | undefined> {
  const info = (await listLogins()).find((l) => l.name === name);
  if (!info) return undefined;
  const raw = await keychain.get(name);
  if (!raw) throw new Error(`The keychain has no values for "${name}". Add it again: sikrets logins add ${name} <url>`);
  const v = JSON.parse(raw) as { username: string; password: string; totp?: string };
  return { ...info, username: Secret.of(v.username), password: Secret.of(v.password), ...(v.totp ? { totpSecret: Secret.of(v.totp) } : {}) };
}

export async function removeLogin(name: string): Promise<boolean> {
  let found = false;
  await updateIndex((all) => {
    found = all.some((l) => l.name === name);
    return found ? all.filter((l) => l.name !== name) : undefined;
  });
  if (found) await keychain.delete(name);
  return found;
}

/** Index entries whose keychain values are gone (deleted outside Sikrets, or a crash): they can't be used until re-added. */
export async function brokenLogins(): Promise<string[]> {
  const broken: string[] = [];
  for (const l of await listLogins()) if (!(await keychain.get(l.name).catch(() => null))) broken.push(l.name);
  return broken;
}
