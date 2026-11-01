import { clientStore, type ClientStore } from "../core/mcp-clients.ts";
import type { Secret } from "../core/secret.ts";
import { MCP_HTTP } from "../constants.ts";

// `sikrets mcp clients`: who may connect to `sikrets mcp --http`. `add` makes a bearer-token
// client (the token goes to the keychain and your clipboard, never the terminal), `token` hands it
// over again into a pipe, `rm` revokes a client (bearer or OAuth) at once, and no argument lists them.

const USAGE = "Usage: sikrets mcp clients [ls] | add <name> | token <name> | rm <name>";

/** Clipboard program for this OS, if one is installed. */
function clipboard(): string[] | undefined {
  if (process.platform === "darwin") return ["pbcopy"];
  if (process.platform === "win32") return ["clip"];
  if (Bun.which("wl-copy")) return ["wl-copy"];
  if (Bun.which("xclip")) return ["xclip", "-selection", "clipboard"];
  return undefined;
}

/** A token goes into a pipe or the clipboard, never onto a terminal screen or into scrollback. */
async function handOver(token: Secret, name: string): Promise<string> {
  if (!process.stdout.isTTY) {
    process.stdout.write(token.reveal());
    return "written to stdout";
  }
  const cmd = clipboard();
  if (cmd) {
    const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(token.reveal());
    await proc.stdin.end();
    if ((await proc.exited) === 0) return "copied to the clipboard";
  }
  return `kept in your keychain; pipe it where it's needed: export ${MCP_HTTP.tokenEnv}="$(sikrets mcp clients token ${name})"`;
}

export async function run(args: string[], opts: Record<string, unknown>, store: ClientStore = clientStore()) {
  const [sub = "ls", name] = args;
  const out = (json: unknown, line: string) => console.error(opts.json ? JSON.stringify(json) : line);

  if (sub === "add") {
    if (!name) throw new Error("Usage: sikrets mcp clients add <name>   (e.g. cursor, claude-code)");
    const token = await store.add(name);
    const where = await handOver(token, name);
    return out(
      { name, token: where },
      `Added client "${name}". Its token is ${where}.\nThe app sends it as "Authorization: Bearer <token>"; see: sikrets mcp config <app> --http`,
    );
  }
  if (sub === "token") {
    if (!name) throw new Error("Usage: sikrets mcp clients token <name>");
    const token = await store.token(name);
    if (!token) throw new Error(`No bearer token for "${name}". Add one with: sikrets mcp clients add ${name}`);
    const where = await handOver(token, name);
    if (process.stdout.isTTY) console.error(`Token for "${name}" ${where}.`);
    return;
  }
  if (sub === "rm" || sub === "revoke") {
    if (!name) throw new Error("Usage: sikrets mcp clients rm <name>");
    if (!(await store.remove(name))) throw new Error(`No client named "${name}"`);
    return out({ name, removed: true }, `Removed "${name}". Its token stops working on its next request.`);
  }
  if (sub !== "ls") throw new Error(`Unknown clients subcommand "${sub}". ${USAGE}`);

  const clients = await store.list();
  // Names and dates only; hashes stay in the file.
  const rows = clients.map((c) => ({ name: c.name, kind: c.kind, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt ?? null }));
  if (opts.json) return console.log(JSON.stringify(rows));
  if (!rows.length) return console.log(`No clients yet. Add one with: sikrets mcp clients add <name>`);
  for (const r of rows) console.log(`  ${r.name.padEnd(28)} ${r.kind.padEnd(6)} added ${r.createdAt.slice(0, 10)}${r.lastUsedAt ? `, last used ${r.lastUsedAt.slice(0, 16).replace("T", " ")}` : ""}`);
}
