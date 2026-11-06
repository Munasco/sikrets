import { lastUsed, readActivity } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { externalKeys } from "../core/keys.ts";
import { checkScope, type ScopeFinding } from "../core/scopes.ts";
import { outputKeys } from "../core/standin.ts";
import { state, type Resource } from "../core/state.ts";
import { ago } from "../core/ttl.ts";
import { readUsage, usageByKey } from "../core/usage.ts";
import { openVault } from "../core/vault.ts";
import { STALE } from "../constants.ts";

// Every stored key in this project: how old it is, when it was last rotated and used, and which
// apps and agents were handed it (from the local usage log). Flags stale keys, and over-scoped
// ones where the provider makes that cheap to tell. Values are read only to classify them.

const DAY = 86_400_000;

export interface InventoryRow {
  key: string;
  resource: string;
  recipe: string;
  createdAt: string;
  lastRotatedAt: string | null;
  lastUsed: string | null;
  apps: string[];
  agents: string[];
  stale: boolean;
  scope: ScopeFinding | null;
  /** Imported or linked keys: where the value came from (they have no resource to rotate). */
  source?: string;
  /** Password manager item this key mirrors (bw://… or op://…). */
  ref?: string;
}

/** Stale: the current value is older than 90 days and nothing was handed it in 30. */
export function isStale(res: Pick<Resource, "createdAt" | "lastRotatedAt">, used: string | undefined, now = Date.now()) {
  const valueAge = now - Date.parse(res.lastRotatedAt ?? res.createdAt);
  const idle = used ? now - Date.parse(used) : Infinity;
  return valueAge > STALE.olderThanDays * DAY && idle > STALE.unusedDays * DAY;
}

export async function inventory(root: string, opts: { offline?: boolean } = {}): Promise<InventoryRow[]> {
  const { ctx } = await projectContext(root, { log: () => {} });
  const { resources } = await state.load(root);
  const usage = usageByKey(await readUsage(ctx.project));
  // Runs recorded before the usage log existed still count as use.
  const ran = lastUsed(await readActivity(root));
  const vault = await openVault(ctx.project, ctx.server);

  const rows: InventoryRow[] = [];
  for (const res of resources.filter((r) => r.applied)) {
    for (const { key } of outputKeys(res).filter((k) => k.sensitive)) {
      const u = usage.get(key);
      const last = [u?.lastUsed, ran.get(key)].filter((x): x is string => Boolean(x)).sort().at(-1);
      const value = await vault.get(key);
      rows.push({
        key,
        resource: res.name,
        recipe: res.recipe,
        createdAt: res.createdAt,
        lastRotatedAt: res.lastRotatedAt ?? null,
        lastUsed: last ?? null,
        apps: [...(u?.apps ?? [])].sort(),
        agents: [...(u?.agents ?? [])].sort(),
        stale: isStale(res, last),
        scope: (value && (await checkScope(value, opts))) ?? null,
      });
    }
  }
  // Keys imported or linked from outside Sikrets.
  const listed = new Set(rows.map((r) => r.key));
  for (const ext of (await externalKeys(root)).filter((k) => !listed.has(k.key))) {
    const u = usage.get(ext.key);
    const last = [u?.lastUsed, ran.get(ext.key)].filter((x): x is string => Boolean(x)).sort().at(-1);
    const value = await vault.get(ext.key);
    rows.push({
      key: ext.key,
      resource: "",
      recipe: "import",
      createdAt: ext.addedAt,
      lastRotatedAt: null,
      lastUsed: last ?? null,
      apps: [...(u?.apps ?? [])].sort(),
      agents: [...(u?.agents ?? [])].sort(),
      stale: isStale({ createdAt: ext.addedAt }, last),
      scope: (value && (await checkScope(value, opts))) ?? null,
      source: ext.source,
      ...(ext.ref ? { ref: ext.ref } : {}),
    });
  }
  return rows;
}

export async function run(_args: string[], opts: Record<string, unknown>) {
  const rows = await inventory(process.cwd(), { offline: Boolean(opts.offline) });
  if (opts.json) return console.log(JSON.stringify({ keys: rows }));
  if (!rows.length) return console.log("No stored keys yet. Add one: sikrets add <provider/service>");
  const w = Math.max(...rows.map((r) => r.key.length), 3);
  console.log(`${"KEY".padEnd(w)}  ${"AGE".padEnd(9)} ${"ROTATED".padEnd(9)} ${"LAST USED".padEnd(10)} USED BY`);
  for (const r of rows) {
    const by = [...r.apps, ...r.agents.map((a) => `agent:${a}`)].join(", ") || "—";
    console.log(`${r.key.padEnd(w)}  ${ago(r.createdAt).padEnd(9)} ${ago(r.lastRotatedAt ?? undefined).padEnd(9)} ${ago(r.lastUsed ?? undefined).padEnd(10)} ${by}`);
    if (r.stale) console.log(`${"".padEnd(w)}  ! stale: older than ${STALE.olderThanDays}d and unused for ${STALE.unusedDays}d. Rotate or remove it: sikrets rotate ${r.resource}`);
    if (r.scope?.overScoped) console.log(`${"".padEnd(w)}  ! over-scoped (${r.scope.provider}): ${r.scope.detail}`);
  }
  const stale = rows.filter((r) => r.stale).length;
  const over = rows.filter((r) => r.scope?.overScoped).length;
  console.log(`\n${rows.length} key(s) · ${stale} stale · ${over} over-scoped${opts.offline ? " (GitHub scopes not checked: --offline)" : ""}`);
}
