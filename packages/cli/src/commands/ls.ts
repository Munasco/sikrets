import { listConnections } from "../store.ts";

export async function run(_args: string[], opts: { json?: string | boolean }) {
  const all = await listConnections();
  if (opts.json) return console.log(JSON.stringify(all));
  if (!all.length) return console.log("No connections yet. Run: sikrets connect <provider>");
  for (const c of all) console.log(`${c.provider.padEnd(10)} ${c.account.padEnd(32)} ${c.mode.padEnd(9)} ${c.connectedAt}`);
}
