import { Secret } from "../core/secret.ts";
import { keychain, listConnections, removeConnection, saveConnection } from "../store.ts";
import { runCli, type RunOptions } from "./exec.ts";
import { statusMessage, type ManagerEntry, type ManagerStatus, type PasswordManager } from "./types.ts";
import { PASSWORD_MANAGERS } from "../constants.ts";

// Bitwarden and Vaultwarden through the official `bw` CLI. Vaultwarden is the same CLI pointed at
// a self-hosted server with `bw config server <url>`. Unlocking yields a BW_SESSION key, which is
// kept in the OS keychain and handed to `bw` through its environment, never printed.
//
// References look like bw://<item id>/<field>, where field is password, username, totp, notes or
// the name of a custom field. The item id is what `bw list items` shows.

const BW = PASSWORD_MANAGERS.bitwarden;
const ID = "bitwarden";
const sessionAccount = (account: string) => `${account}#session`;

interface Field {
  name: string;
  value: string | null;
  type: number;
}
interface Item {
  id: string;
  name: string;
  notes: string | null;
  login?: { username: string | null; password: string | null; totp: string | null };
  fields?: Field[];
}
/** Bitwarden custom field types: 0 text, 1 hidden, 2 boolean. */
const HIDDEN = 1;

export function parseRef(ref: string): { id: string; field: string } {
  const m = /^bw:\/\/([^/]+)(?:\/(.+))?$/.exec(ref);
  if (!m) throw new Error(`"${ref}" isn't a Bitwarden reference; expected ${BW.refScheme}<item id>/<field>`);
  return { id: m[1]!, field: m[2] ?? "password" };
}

function getField(item: Item, field: string): string | null | undefined {
  switch (field) {
    case "password":
    case "username":
    case "totp":
      return item.login?.[field];
    case "notes":
      return item.notes;
    default:
      return item.fields?.find((f) => f.name === field)?.value;
  }
}

function setField(item: Item, field: string, value: string): Item {
  if (field === "password" || field === "username" || field === "totp") {
    if (!item.login) throw new Error(`"${item.name}" isn't a login item, so it has no ${field}`);
    return { ...item, login: { ...item.login, [field]: value } };
  }
  if (field === "notes") return { ...item, notes: value };
  const fields = item.fields ?? [];
  const exists = fields.some((f) => f.name === field);
  return { ...item, fields: exists ? fields.map((f) => (f.name === field ? { ...f, value } : f)) : [...fields, { name: field, value, type: HIDDEN }] };
}

/** The session Sikrets would use: BW_SESSION from the environment, else the one saved by `sikrets unlock`. */
async function session(): Promise<{ token: Secret; account?: string } | undefined> {
  const fromEnv = Bun.env[BW.sessionEnv];
  if (fromEnv) return { token: Secret.of(fromEnv) };
  const conn = (await listConnections()).find((c) => c.provider === ID);
  const saved = conn && (await keychain.get(ID, sessionAccount(conn.account)));
  return saved ? { token: Secret.of(saved), account: conn.account } : undefined;
}

interface CliStatus {
  serverUrl: string | null;
  userEmail?: string;
  status: "unauthenticated" | "locked" | "unlocked";
}

/** `bw status`, with the session when there is one (bw reports "unlocked" only for a valid session). */
async function cliStatus(token?: Secret): Promise<CliStatus> {
  const env: Record<string, string> = token ? { [BW.sessionEnv]: token.reveal() } : {};
  return JSON.parse(await runCli(BW, ["status", "--nointeraction"], { env, secrets: token ? [token] : [] })) as CliStatus;
}

async function status(): Promise<ManagerStatus> {
  const s = await session();
  const cli = await cliStatus(s?.token);
  if (cli.status === "unauthenticated") return { state: "unauthenticated" };
  const account = s?.account ?? cli.userEmail ?? "bitwarden";
  if (!s) return { state: "locked", ...(cli.userEmail ? { account: cli.userEmail } : {}) };
  return cli.status === "unlocked" ? { state: "unlocked", account } : { state: "expired", account };
}

async function bw(args: string[], opts: RunOptions & { session?: boolean } = {}) {
  const env: Record<string, string> = { ...opts.env };
  const secrets = [...(opts.secrets ?? [])];
  if (opts.session !== false) {
    const s = await session();
    if (!s) throw new Error(statusMessage(BW.name, ID, { state: "locked" }));
    env[BW.sessionEnv] = s.token.reveal();
    secrets.push(s.token);
  }
  try {
    return await runCli(BW, opts.interactive ? args : [...args, "--nointeraction"], { ...opts, env, secrets });
  } catch (error) {
    // A stale session fails with bw's raw message; say what actually happened instead.
    if (opts.session === false) throw error;
    const now = await status().catch(() => undefined);
    if (now && now.state !== "unlocked") throw new Error(statusMessage(BW.name, ID, now));
    throw error;
  }
}

const getItem = async (id: string) => JSON.parse(await bw(["get", "item", id])) as Item;

export const bitwarden: PasswordManager = {
  id: ID,
  name: BW.name,
  owns: (ref) => ref.startsWith(BW.refScheme),

  async read(ref) {
    const { id, field } = parseRef(ref);
    const item = await getItem(id);
    const value = getField(item, field);
    if (!value) throw new Error(`Bitwarden item "${item.name}" has no ${field}`);
    return Secret.of(value);
  },

  async write(ref, value) {
    const { id, field } = parseRef(ref);
    await bw(["sync"]); // edit the latest copy, not a stale local cache
    const item = setField(await getItem(id), field, value.reveal());
    // `bw edit` takes base64 JSON on stdin (what `bw encode` produces), keeping the value out of argv.
    await bw(["edit", "item", id], { stdin: Buffer.from(JSON.stringify(item)).toString("base64"), secrets: [value] });
  },

  async list() {
    await bw(["sync"]);
    const items = JSON.parse(await bw(["list", "items"])) as Item[];
    const out: ManagerEntry[] = [];
    for (const item of items) {
      const entry = (field: string, value: string | null | undefined) =>
        value && out.push({ ref: `${BW.refScheme}${item.id}/${field}`, item: item.name, field, value: Secret.of(value) });
      entry("password", item.login?.password);
      entry("totp", item.login?.totp);
      for (const f of item.fields ?? []) if (f.type === HIDDEN) entry(f.name, f.value);
    }
    return out;
  },

  async unlock({ server, email, password, say }) {
    if (server?.startsWith("http://")) say("  Note: recent bw versions refuse plain-HTTP servers; serve Vaultwarden over HTTPS if login fails");
    const current = await cliStatus();
    const account = email ?? current.userEmail;
    if (!account) throw new Error("bw isn't signed in yet; pass --email");
    // Switching servers is undone if sign-in then fails, so a bad password doesn't leave bw pointed elsewhere.
    let restore: string | undefined;
    if (server && current.serverUrl?.replace(/\/$/, "") !== server.replace(/\/$/, "")) {
      if (current.status !== "unauthenticated") throw new Error(`bw is signed in to ${current.serverUrl ?? "bitwarden.com"}; run \`bw logout\` first to switch to ${server}`);
      restore = current.serverUrl ?? BW.defaultServer;
      await bw(["config", "server", server], { session: false });
    }
    const pw = await password();
    const env = { [BW.passwordEnv]: pw.reveal() };
    let token: string;
    try {
      // Login may ask for a 2FA code, so it gets the terminal; unlock never does.
      const raw =
        current.status === "unauthenticated"
          ? await bw(["login", account, "--passwordenv", BW.passwordEnv, "--raw"], { session: false, interactive: true, env, secrets: [pw] })
          : await bw(["unlock", "--passwordenv", BW.passwordEnv, "--raw"], { session: false, env, secrets: [pw] });
      token = raw.trim();
      if (!token) throw new Error("bw returned no session");
    } catch (error) {
      if (restore) await bw(["config", "server", restore], { session: false }).catch(() => undefined);
      throw error;
    }
    if (restore) say(`Pointed bw at ${server}`);
    await keychain.set(ID, sessionAccount(account), token);
    await saveConnection({ provider: ID, account, mode: "terminal", connectedAt: new Date().toISOString() });
    return account;
  },

  async lock() {
    const conn = (await listConnections()).find((c) => c.provider === ID);
    await bw(["lock"], { session: false }).catch(() => undefined);
    if (conn) await keychain.delete(ID, sessionAccount(conn.account));
    await removeConnection(ID);
  },

  status,
};
