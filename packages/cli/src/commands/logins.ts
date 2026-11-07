import { listGrants, revokeGrants } from "../core/logins/grants.ts";
import { addLogin, brokenLogins, checkName, listLogins, removeLogin } from "../core/logins/store.ts";
import { Secret } from "../core/secret.ts";
import { promptHidden, promptLine } from "../ui.ts";

// `sikrets logins` manages website logins for agents. `add` stores one (values go to the keychain,
// prompted hidden or piped, never as arguments), `ls` shows names and origins, `rm` deletes one and
// its grants, `grants` shows which agent may use which login, and `revoke` takes that back.

const USAGE = "Usage: sikrets logins add <name> <url> | ls | rm <name> | grants | revoke <name> [--agent NAME]";

async function readValues(opts: Record<string, unknown>) {
  // Piped: the password on the first line, the TOTP secret (with --totp) on the second.
  if (opts["password-stdin"]) {
    const [password = "", totp = ""] = (await Bun.stdin.text()).split(/\r?\n/);
    if (opts.totp && !totp.trim()) throw new Error("--totp with --password-stdin: put the TOTP secret on the second line");
    return { password: Secret.of(password), totp: opts.totp ? Secret.of(totp.trim()) : undefined };
  }
  if (!process.stdin.isTTY) throw new Error("No terminal to ask in; pipe the password with --password-stdin");
  const password = Secret.of(await promptHidden("Password (hidden): "));
  const totp = opts.totp ? Secret.of((await promptHidden("2FA secret, otpauth:// URI or base32 (hidden): ")).trim()) : undefined;
  return { password, totp };
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const [sub = "ls", name, url] = args;
  const out = (json: unknown, line: string) => console.log(opts.json ? JSON.stringify(json) : line);

  if (sub === "add") {
    if (!name || !url) throw new Error("Usage: sikrets logins add <name> <url> [--username USER] [--totp]");
    checkName(name);
    const user = typeof opts.username === "string" ? opts.username : await promptLine("Username or email: ");
    if (!user) throw new Error("A username is required");
    const { password, totp } = await readValues(opts);
    const info = await addLogin({ name, url, username: Secret.of(user), password, ...(totp ? { totpSecret: totp } : {}) });
    return out(info, `Stored ${info.name} for ${info.origin}${info.totp ? " with 2FA" : ""} in your keychain. Agents can now sign in with it (you'll be asked first).`);
  }
  if (sub === "rm") {
    if (!name) throw new Error("Usage: sikrets logins rm <name>");
    const removed = await removeLogin(name);
    const revoked = await revokeGrants(name);
    if (!removed) throw new Error(`No login named "${name}"`);
    return out({ name, removed, revoked }, `Removed ${name}${revoked ? ` and ${revoked} agent grant(s)` : ""}.`);
  }
  if (sub === "grants") {
    const grants = await listGrants();
    if (opts.json) return console.log(JSON.stringify(grants));
    if (!grants.length) return console.log("No agent has a standing grant. Each one is asked on first use.");
    for (const g of grants) console.log(`  ${g.login.padEnd(16)} ${g.agent.padEnd(24)} ${g.origin.padEnd(28)} since ${g.grantedAt.slice(0, 10)}`);
    return;
  }
  if (sub === "revoke") {
    if (!name) throw new Error("Usage: sikrets logins revoke <name> [--agent NAME]");
    const agent = typeof opts.agent === "string" ? opts.agent : undefined;
    const revoked = await revokeGrants(name, agent);
    return out({ name, agent: agent ?? null, revoked }, revoked ? `Revoked ${revoked} grant(s) for ${name}. ${agent ?? "Every agent"} will be asked again.` : `No grants for ${name}${agent ? ` and ${agent}` : ""}.`);
  }
  if (sub !== "ls") throw new Error(`Unknown logins subcommand "${sub}". ${USAGE}`);

  const logins = await listLogins();
  const broken = new Set(await brokenLogins());
  if (opts.json) return console.log(JSON.stringify(logins.map((l) => ({ ...l, missingValues: broken.has(l.name) }))));
  if (!logins.length) return console.log("No logins yet. Add one: sikrets logins add <name> <url>");
  for (const l of logins) console.log(`  ${l.name.padEnd(16)} ${l.origin}${l.totp ? "  (2FA)" : ""}${broken.has(l.name) ? "  (values missing from the keychain: add it again)" : ""}`);
}
