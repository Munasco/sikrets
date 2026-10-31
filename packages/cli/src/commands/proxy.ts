import { SERVICES, service } from "../core/proxy/services.ts";
import { tokens } from "../core/proxy/tokens.ts";
import { readSecretInput } from "./secret-input.ts";

// `sikrets proxy add <service>` stores the real token the proxy attaches for that service.
// `sikrets proxy ls` shows which services have one (never the token). `sikrets proxy rm` forgets it.
export async function run(args: string[], opts: Record<string, unknown>) {
  const [sub, id] = args;
  if (sub === "add") {
    if (!id) throw new Error("Usage: sikrets proxy add <service>");
    const s = service(id);
    if (!opts["value-stdin"]) console.error(`Create a token at ${s.tokenUrl}`);
    const value = await readSecretInput(opts, `${s.name} token (hidden): `);
    await tokens.set(s.id, value);
    return console.log(opts.json ? JSON.stringify({ service: s.id, stored: true }) : `Stored the ${s.name} token in your keychain (${value.hint()}).`);
  }
  if (sub === "rm") {
    if (!id) throw new Error("Usage: sikrets proxy rm <service>");
    await tokens.delete(service(id).id);
    return console.log(`Removed the ${service(id).name} token.`);
  }
  if (sub && sub !== "ls") throw new Error(`Unknown proxy subcommand "${sub}". Use: add, ls, rm`);

  // `ls` shows what you've stored; `ls <search>` searches every service the proxy can broker.
  const query = id?.toLowerCase();
  const matches = query ? SERVICES.filter((s) => s.id.includes(query) || s.name.toLowerCase().includes(query)) : SERVICES;
  const rows = (await Promise.all(matches.map(async (s) => ({ id: s.id, name: s.name, hosts: Object.keys(s.hosts), stored: (await tokens.get(s.id)) !== undefined })))).filter(
    (r) => query || r.stored,
  );
  if (opts.json) return console.log(JSON.stringify(rows));
  for (const r of rows.slice(0, 50)) console.log(`  ${r.stored ? "●" : "○"} ${r.id.padEnd(22)} ${r.hosts.join(", ")}`);
  if (rows.length > 50) console.log(`  … and ${rows.length - 50} more`);
  if (!rows.length) console.log(query ? `No service matches "${id}".` : "No tokens stored yet.");
  console.log(`\n${SERVICES.length} services can be used in a session. Search: sikrets proxy ls <name> · add: sikrets proxy add <id>`);
}
