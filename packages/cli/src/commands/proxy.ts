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

  const rows = await Promise.all(SERVICES.map(async (s) => ({ id: s.id, name: s.name, hosts: Object.keys(s.hosts), stored: (await tokens.get(s.id)) !== undefined })));
  if (opts.json) return console.log(JSON.stringify(rows));
  for (const r of rows) console.log(`  ${r.stored ? "●" : "○"} ${r.id.padEnd(10)} ${r.hosts.join(", ")}`);
  console.log("\n● token stored  ○ none yet: sikrets proxy add <service>");
}
