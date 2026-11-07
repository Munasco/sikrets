import path from "node:path";
import { record } from "../core/activity.ts";
import { openBackup, parseBackup, planRestore, prune, sealBackup, summarize, type BackupFile, type BackupPayload, type Login, type Unlock } from "../core/backup.ts";
import { hasConfig, projectContext, writeConfig, type ProjectConfig } from "../core/config.ts";
import { loadDataKey } from "../core/datakey.ts";
import { writePrivate } from "../core/fs.ts";
import type { Context } from "../core/plan.ts";
import { outputKeys, standInKey } from "../core/standin.ts";
import { Secret } from "../core/secret.ts";
import { state } from "../core/state.ts";
import { openVault, ssmParams } from "../core/vault.ts";
import { providers } from "../providers/index.ts";
import { configDir, keychain, listConnections, saveConnection } from "../store.ts";
import { log, promptHidden } from "../ui.ts";
import { BACKUP } from "../constants.ts";

// sikrets backup create [file] | verify <file> | restore <file>. Output names keys and counts,
// never values. A backup file is safe to copy anywhere: without the data key or passphrase it is
// noise. --dir plus --keep is the scheduled form: point cron at it and old files are pruned.

export async function run(args: string[], opts: Record<string, unknown>) {
  const [action, file] = args;
  const say = (m: string) => log(opts, m);
  const root = process.cwd();
  const { config, ctx } = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: say });
  switch (action) {
    case "create":
      return create(root, config, ctx, file, opts, say);
    case "verify":
    case "restore": {
      if (!file) throw new Error(`Usage: sikrets backup ${action} <file>`);
      const backup = parseBackup(await readFile(file));
      const payload = await openBackup(backup, await unlockFor(backup, opts));
      return action === "verify" ? verify(backup, payload, opts) : restore(root, ctx, payload, opts, say);
    }
    default:
      throw new Error(`Unknown action "${action}". Use: sikrets backup create | verify | restore`);
  }
}

async function readFile(file: string) {
  const f = Bun.file(path.resolve(file));
  if (!(await f.exists())) throw new Error(`No file at ${file}`);
  return f.text();
}

// ── create ──

async function create(root: string, config: ProjectConfig, ctx: Context, file: string | undefined, opts: Record<string, unknown>, say: (m: string) => void) {
  const unlock = await createUnlock(opts);
  const payload = await collect(root, config, ctx, !opts["no-logins"]);
  const sealed = await sealBackup(payload, unlock);

  const dir = typeof opts.dir === "string" ? path.resolve(opts.dir) : path.join(configDir(), BACKUP.dir);
  const target = file ? path.resolve(file) : path.join(dir, BACKUP.fileName(ctx.project, new Date(sealed.createdAt)));
  await writePrivate(target, JSON.stringify(sealed, null, 2) + "\n");
  const pruned = typeof opts.dir === "string" ? await prune(dir, ctx.project, keepCount(opts.keep)) : [];
  await record(root, { kind: "backup", detail: `create (${sealed.mode}) ${path.basename(target)}`, keys: Object.keys(payload.values) });

  const s = summarize(payload);
  if (opts.json) return console.log(JSON.stringify({ file: target, mode: sealed.mode, values: s.values, resources: s.resources.length, logins: s.logins, pruned: pruned.length }));
  say(`Backed up ${s.values} value(s), ${s.resources.length} resource(s), ${s.connections.length} link(s) and ${s.logins} login(s) to ${target} (mode 600).`);
  say(sealed.mode === "passphrase" ? "It opens with the passphrase on any machine." : "It opens with your data key. Without recovery set up, use --passphrase for a copy you keep off this device.");
  if (pruned.length) say(`Pruned ${pruned.length} older backup(s), keeping ${keepCount(opts.keep)}.`);
}

const keepCount = (raw: unknown) => {
  const n = raw === undefined ? BACKUP.keep : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--keep must be a whole number of at least 1");
  return n;
};

/** Every value this project has in its vault, plus links and keychain logins. */
async function collect(root: string, config: ProjectConfig, ctx: Context, withLogins: boolean): Promise<BackupPayload> {
  const vault = await openVault(ctx.project, ctx.vault, ctx);
  const { resources } = await state.load(root);
  const keys = new Set(resources.flatMap(outputKeys).flatMap((k) => [k.key, standInKey(k.key)]));
  // SSM can be listed, so values Sikrets no longer tracks in state are kept too.
  if (ctx.vault === "ssm") for (const k of (await (await ssmParams(ctx.project)).list()).keys()) keys.add(k);
  const values: Record<string, string> = {};
  for (const key of [...keys].sort()) {
    const value = await vault.get(key);
    if (value) values[key] = value.reveal();
  }
  const connections = await listConnections();
  return { project: ctx.project, values, resources, config: (await hasConfig(root)) ? config : undefined, connections, logins: withLogins ? await collectLogins() : [] };
}

/** Passwords and minted API keys that `connect` saved to the keychain, found through the links. */
async function collectLogins(): Promise<Login[]> {
  const out: Login[] = [];
  for (const c of await listConnections()) {
    const mint = providers[c.provider]?.mint?.key;
    for (const account of [c.account, ...(mint ? [`${c.account}#${mint}`] : [])]) {
      const value = await keychain.get(c.provider, account);
      if (value) out.push({ provider: c.provider, account, value });
    }
  }
  return out;
}

// ── unlocking ──

async function readPassphrase(opts: Record<string, unknown>, confirmIt: boolean): Promise<string> {
  if (opts["passphrase-stdin"]) return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  if (!process.stdin.isTTY) throw new Error("No terminal to ask in; pipe the passphrase with --passphrase-stdin");
  const first = await promptHidden("Backup passphrase: ");
  if (confirmIt && (await promptHidden("Again: ")) !== first) throw new Error("The passphrases don't match. Nothing was written");
  return first;
}

async function createUnlock(opts: Record<string, unknown>): Promise<Unlock> {
  if (opts.passphrase || opts["passphrase-stdin"]) return { passphrase: await readPassphrase(opts, true) };
  const dataKey = await loadDataKey();
  if (!dataKey) throw new Error("This device has no data key yet. Use --passphrase, or set one up with: sikrets recovery setup");
  return { dataKey };
}

async function unlockFor(backup: BackupFile, opts: Record<string, unknown>): Promise<Unlock> {
  if (backup.mode === "passphrase") return { passphrase: await readPassphrase(opts, false) };
  const dataKey = await loadDataKey();
  if (!dataKey) throw new Error("This backup opens with your data key, and this device doesn't have it. Restore it first: sikrets recovery restore");
  return { dataKey };
}

// ── verify and restore ──

function verify(backup: BackupFile, payload: BackupPayload, opts: Record<string, unknown>) {
  const s = summarize(payload);
  if (opts.json) return console.log(JSON.stringify({ ok: true, createdAt: backup.createdAt, mode: backup.mode, ...s }));
  console.log(`OK: ${backup.mode} backup of "${s.project}" from ${backup.createdAt}`);
  console.log(`  ${s.values} value(s), ${s.resources.length} resource(s), ${s.connections.length} link(s), ${s.logins} login(s)${s.config ? ", sikrets.json" : ""}`);
}

async function restore(root: string, ctx: Context, payload: BackupPayload, opts: Record<string, unknown>, say: (m: string) => void) {
  if (payload.project !== ctx.project && !opts.force) {
    throw new Error(`This backup is of "${payload.project}" but this directory is "${ctx.project}". Run it in that project, or pass --force to restore into "${ctx.project}"`);
  }
  const vault = await openVault(ctx.project, ctx.vault, ctx);
  const current = new Map<string, string | undefined>();
  for (const key of Object.keys(payload.values)) {
    // A value this device can't open counts as different, so restore replaces it.
    current.set(key, await vault.get(key).then((v) => v?.reveal(), () => "\0unreadable"));
  }
  const plan = planRestore(payload, current);
  const local = new Set((await state.load(root)).resources.map((r) => r.name));
  const resources = payload.resources.filter((r) => !local.has(r.name));
  const known = new Set((await listConnections()).map((c) => c.provider));
  const connections = payload.connections.filter((c) => !known.has(c.provider));
  const logins: Login[] = [];
  for (const l of payload.logins) if (!(await keychain.get(l.provider, l.account))) logins.push(l);
  const writeConfigFile = Boolean(payload.config) && !(await hasConfig(root));

  const summary = { dryRun: ctx.dryRun, ...plan, resources: resources.map((r) => r.name), connections: connections.map((c) => c.provider), logins: logins.length, config: writeConfigFile };
  say(`${ctx.dryRun ? "Dry run — would restore" : "Restoring"} into the ${ctx.vault} vault of "${ctx.project}":`);
  if (plan.add.length) say(`  + ${plan.add.length} new value(s): ${plan.add.join(", ")}`);
  if (plan.replace.length) say(`  ~ ${plan.replace.length} changed value(s): ${plan.replace.join(", ")}`);
  if (plan.same.length) say(`  = ${plan.same.length} unchanged`);
  if (resources.length) say(`  + resources in .sikrets/state.json: ${resources.map((r) => r.name).join(", ")}`);
  if (writeConfigFile) say("  + sikrets.json");
  if (connections.length) say(`  + links: ${connections.map((c) => c.provider).join(", ")}`);
  if (logins.length) say(`  + ${logins.length} login(s) to the keychain`);
  if (ctx.dryRun) return opts.json ? console.log(JSON.stringify(summary)) : undefined;

  for (const key of [...plan.add, ...plan.replace]) await vault.put(key, Secret.of(payload.values[key]!));
  for (const r of resources) await state.upsert(root, r);
  if (writeConfigFile) await writeConfig(root, { ...payload.config!, project: ctx.project });
  for (const c of connections) await saveConnection(c);
  for (const l of logins) await keychain.set(l.provider, l.account, l.value);
  await record(root, { kind: "backup", detail: `restore from ${payload.project}`, keys: [...plan.add, ...plan.replace] });
  if (opts.json) console.log(JSON.stringify(summary));
  else say(`Restored ${plan.add.length + plan.replace.length} value(s).`);
}
