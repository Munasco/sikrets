import { Secret } from "../core/secret.ts";
import { keychain, listConnections, saveConnection } from "../store.ts";
import { runCli, type RunOptions } from "./exec.ts";
import type { ManagerEntry, PasswordManager } from "./types.ts";
import { PASSWORD_MANAGERS } from "../constants.ts";

// 1Password through the `op` CLI, using its own secret references: op://<vault>/<item>/[section/]<field>.
// `op signin --raw` yields a session token, kept in the OS keychain and passed back to `op` as
// OP_SESSION_<user uuid>. With the desktop app integration or a service account token there is no
// token to keep, and `op` authenticates on its own.

const OP = PASSWORD_MANAGERS.onepassword;
const ID = "1password";
const sessionAccount = (account: string) => `${account}#session`;

interface Field {
  id: string;
  type: string;
  label?: string;
  value?: string;
  reference?: string;
  section?: { id: string; label?: string };
}
interface Item {
  id: string;
  title: string;
  vault: { id: string; name?: string };
  fields?: Field[];
}

export function parseRef(ref: string): { vault: string; item: string; section?: string; field: string } {
  const parts = ref.startsWith(OP.refScheme) ? ref.slice(OP.refScheme.length).split("/") : [];
  if (parts.length !== 3 && parts.length !== 4) throw new Error(`"${ref}" isn't a 1Password reference; expected ${OP.refScheme}<vault>/<item>/[section/]<field>`);
  const [vault, item, a, b] = parts as [string, string, string, string?];
  return b === undefined ? { vault, item, field: a } : { vault, item, section: a, field: b };
}

async function auth(): Promise<{ env: Record<string, string>; args: string[]; secrets: Secret[] }> {
  const conn = (await listConnections()).find((c) => c.provider === ID);
  if (!conn || Bun.env[OP.serviceAccountEnv]) return { env: {}, args: [], secrets: [] };
  const token = await keychain.get(ID, sessionAccount(conn.account));
  if (!token) return { env: {}, args: ["--account", conn.account], secrets: [] };
  return { env: { [`${OP.sessionEnvPrefix}${conn.account}`]: token }, args: ["--account", conn.account], secrets: [Secret.of(token)] };
}

async function op(args: string[], opts: RunOptions = {}) {
  const a = await auth();
  return runCli(OP, [...args, ...a.args], { ...opts, env: { ...a.env, ...opts.env }, secrets: [...a.secrets, ...(opts.secrets ?? [])] });
}

const matches = (f: Field, name: string, section?: string) =>
  (f.label === name || f.id === name) && (section === undefined || f.section?.label === section || f.section?.id === section);

export const onepassword: PasswordManager = {
  id: ID,
  name: OP.name,
  owns: (ref) => ref.startsWith(OP.refScheme),

  async read(ref) {
    parseRef(ref);
    const value = await op(["read", "--no-newline", ref]);
    if (!value) throw new Error(`${ref} is empty`);
    return Secret.of(value);
  },

  async write(ref, value) {
    const { vault, item, section, field } = parseRef(ref);
    const current = JSON.parse(await op(["item", "get", item, "--vault", vault, "--format", "json"])) as Item;
    const target = current.fields?.find((f) => matches(f, field, section));
    if (!target) throw new Error(`1Password item "${current.title}" has no field "${field}"`);
    const next = { ...current, fields: current.fields!.map((f) => (f === target ? { ...f, value: value.reveal() } : f)) };
    // The edited item goes in as a template on stdin; `op item edit item field=value` would put the value in argv.
    await op(["item", "edit", current.id, "--vault", vault, "--template", "/dev/stdin"], { stdin: JSON.stringify(next), secrets: [value] });
  },

  async list() {
    const items = JSON.parse(await op(["item", "list", "--format", "json"])) as Item[];
    const out: ManagerEntry[] = [];
    for (const { id, vault } of items) {
      const item = JSON.parse(await op(["item", "get", id, "--vault", vault.id, "--format", "json"])) as Item;
      for (const f of item.fields ?? []) {
        if (f.type !== "CONCEALED" || !f.value) continue;
        const field = f.label || f.id;
        out.push({ ref: f.reference ?? `${OP.refScheme}${vault.id}/${item.id}/${field}`, item: item.title, field, value: Secret.of(f.value) });
      }
    }
    return out;
  },

  async unlock({ email, say }) {
    if (Bun.env[OP.serviceAccountEnv]) {
      say(`${OP.serviceAccountEnv} is set; op needs no sign-in`);
      return "service-account";
    }
    const accounts = JSON.parse(await runCli(OP, ["account", "list", "--format", "json"])) as { email: string; user_uuid: string; url: string }[];
    const account = email ? accounts.find((a) => a.email === email) : accounts[0];
    if (!account) throw new Error(email ? `op has no account for ${email}; add it with: op account add` : "op has no accounts yet; add one with: op account add");
    // op asks for the password itself (or hands off to the desktop app), so it gets the terminal.
    const token = (await runCli(OP, ["signin", "--account", account.user_uuid, "--raw"], { interactive: true })).trim();
    if (token) await keychain.set(ID, sessionAccount(account.user_uuid), token);
    else say("Signed in through the 1Password app; no session token to keep");
    await saveConnection({ provider: ID, account: account.user_uuid, mode: "terminal", connectedAt: new Date().toISOString() });
    return account.email;
  },

  async lock() {
    const conn = (await listConnections()).find((c) => c.provider === ID);
    if (!conn) return;
    await op(["signout"]).catch(() => undefined);
    await keychain.delete(ID, sessionAccount(conn.account));
  },
};
