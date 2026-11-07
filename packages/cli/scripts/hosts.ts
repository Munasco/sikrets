// Builds src/catalog/hosts.json from host research (scratch files with one finding per service):
// a host is kept only if it resolves and answers HTTPS. Combined with the own-domain rule in
// services.ts, a wrong guess fails closed (the key isn't attached) instead of going somewhere else.
// Usage: bun scripts/hosts.ts <findings.json>...
import { lookup } from "node:dns/promises";

interface Finding { id: string; hosts: string[]; confidence: "high" | "medium" | "low"; source?: string; basic?: string; note?: string }

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CONCURRENCY = 24;

async function live(host: string): Promise<number | undefined> {
  if (!HOST.test(host)) return undefined;
  try {
    await lookup(host);
    const res = await fetch(`https://${host}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8_000) });
    return res.status;
  } catch {
    return undefined;
  }
}

const findings: Finding[] = [];
for (const file of Bun.argv.slice(2)) findings.push(...((await Bun.file(file).json()) as Finding[]));
const out: (Finding & { status?: Record<string, number> })[] = [];
const queue = [...findings];
let dropped = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const hosts = [...new Set(f.hosts.map((h) => h.toLowerCase().trim()))];
    const status: Record<string, number> = {};
    for (const h of hosts) {
      const s = await live(h);
      if (s === undefined) dropped++;
      else status[h] = s;
    }
    out.push({ ...f, hosts: Object.keys(status), status });
  }
}));
out.sort((a, b) => a.id.localeCompare(b.id));
await Bun.write(new URL("../src/catalog/hosts.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
const kept = out.filter((f) => f.hosts.length && f.confidence !== "low").length;
console.log(`${findings.length} findings: ${kept} services with a live host, ${dropped} hosts dropped (no DNS or no HTTPS)`);
