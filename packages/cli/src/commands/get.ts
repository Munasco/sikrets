import { lastUsed, readActivity, record } from "../core/activity.ts";
import { clipboard } from "../core/clipboard.ts";
import { projectContext } from "../core/config.ts";
import { requireOwner } from "../core/doorman.ts";
import { externalKeys } from "../core/keys.ts";
import { outputKeys, standInFor } from "../core/standin.ts";
import { state } from "../core/state.ts";
import { ago } from "../core/ttl.ts";
import { readUsage, recordUse, usageByKey } from "../core/usage.ts";
import { isVaultKey, openVault } from "../core/vault.ts";
import { REVEAL } from "../constants.ts";

// `sikrets get KEY` prints the key's stand-in on stdout, so `X=$(sikrets get X)` is scriptable and
// safe in any transcript; details go to stderr on a terminal, or alongside it with --json.
// `--real` prints the real value and `--copy` puts it on the clipboard, both only after the Mac's
// owner authenticates (Touch ID or the login password), and both are recorded by key name.
export async function run(args: string[], opts: Record<string, unknown>) {
  const [key] = args;
  if (!key || !isVaultKey(key)) throw new Error("Usage: sikrets get <KEY>, e.g. sikrets get ANTHROPIC_API_KEY");
  if (opts.real && opts.copy) throw new Error("Use --real or --copy, not both");
  const root = process.cwd();
  const { ctx } = await projectContext(root, { log: () => {} });
  const vault = await openVault(ctx.project, ctx.server);
  if (!(await vault.has(key))) throw new Error(`${key} isn't in the vault for ${ctx.project} on ${vault.server}. See: sikrets env`);

  if (opts.real || opts.copy) {
    await requireOwner(opts.copy ? `copy ${key} to the clipboard` : `show the real value of ${key}`);
    const value = await vault.get(key);
    if (!value) throw new Error(`${key} isn't in the vault for ${ctx.project} on ${vault.server}`);
    const via = opts.copy ? "copy" : "real";
    await record(root, { kind: "reveal", detail: `get --${via}`, keys: [key] });
    await recordUse(ctx.project, { keys: [key], via: "get", app: opts.copy ? "clipboard" : "terminal" });
    if (!opts.copy) return void process.stdout.write(`${value.reveal()}\n`);
    await clipboard.copy(value);
    clipboard.clearLater(value);
    return console.error(`Copied ${key}. The clipboard clears in ${REVEAL.clipboardClearSeconds}s.`);
  }

  const standIn = await standInFor(vault, key);
  const info = await details(root, ctx.project, key);
  if (opts.json) return console.log(JSON.stringify({ key, standIn: standIn.reveal(), project: ctx.project, server: vault.server, set: true, ...info }));
  console.log(standIn.reveal());
  if (!process.stderr.isTTY) return;
  console.error(`${key} · ${ctx.project} · ${vault.server} · set (stand-in above; --real or --copy for the value)`);
  if (info.resource) console.error(`  resource      ${info.resource}`);
  if (info.source) console.error(`  source        ${info.source}`);
  console.error(`  last used     ${ago(info.lastUsed ?? undefined)}`);
  if (info.lastRotatedAt) console.error(`  rotated       ${info.lastRotatedAt.slice(0, 10)}`);
  if (info.rotateBy) console.error(`  rotate by     ${info.rotateBy.slice(0, 10)}`);
}

/** Everything known about a key except its value. */
async function details(root: string, project: string, key: string) {
  const { resources } = await state.load(root);
  const res = resources.find((r) => r.applied && outputKeys(r).some((k) => k.key === key));
  const ext = (await externalKeys(root)).find((k) => k.key === key);
  const used = [usageByKey(await readUsage(project)).get(key)?.lastUsed, lastUsed(await readActivity(root)).get(key)];
  return {
    resource: res?.name ?? null,
    source: ext?.source ?? null,
    lastUsed: used.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null,
    lastRotatedAt: res?.lastRotatedAt ?? null,
    rotateBy: res?.rotateBy ?? null,
  };
}
