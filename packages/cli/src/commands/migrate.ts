import { randomBytes } from "node:crypto";
import { record } from "../core/activity.ts";
import { hasConfig, projectContext, writeConfig } from "../core/config.ts";
import { loadDataKey } from "../core/datakey.ts";
import { projectKey } from "../core/envelope.ts";
import { migrateEncrypt } from "../core/migrate.ts";
import { readRecord } from "../core/recovery.ts";
import { isRemoteVault, vaultParams, writeKey } from "../core/vault.ts";
import { confirm, log } from "../ui.ts";
import { ENCRYPTION_REQUIRED } from "../constants.ts";

// sikrets migrate encrypt [--dry-run] [--purge-history]: seals this project's plaintext SSM
// parameters with the data key, in place. Safe to re-run. Once nothing plaintext is left, the
// project is marked "encryption": "required" so a plaintext value planted later is refused.

export async function run(args: string[], opts: Record<string, unknown>) {
  if (args[0] !== "encrypt") throw new Error(`Unknown migration "${args[0] ?? ""}". Use: sikrets migrate encrypt`);
  const root = process.cwd();
  const say = (m: string) => log(opts, m);
  const dryRun = Boolean(opts["dry-run"]);
  const purgeHistory = Boolean(opts["purge-history"]);
  const { config, ctx } = await projectContext(root, { dryRun, log: say });
  if (!isRemoteVault(ctx.vault)) {
    if (opts.json) return console.log(JSON.stringify({ vault: ctx.vault, sealed: [], already: [], unreadable: [], purged: [], changed: [] }));
    return say(`Nothing to migrate: the ${ctx.vault} vault never leaves this machine.`);
  }

  const params = await vaultParams(ctx.project, ctx.vault);
  say(`${dryRun ? "Dry run — checking" : "Encrypting"} values under /sikrets/${ctx.project}/ …`);
  if (!dryRun && purgeHistory && !opts.yes && process.stdin.isTTY) {
    if (!(await confirm("Delete and recreate each parameter to drop its history? Take a backup first (sikrets backup create)."))) return say("Cancelled; nothing changed.");
  }
  // A dry run must not create a data key; without one, it previews with a throwaway key.
  const dataKey = await loadDataKey();
  if (dryRun && !dataKey) say("This device has no data key yet; the first real run creates one (or restore yours: sikrets recovery restore).");
  const key = dataKey ? projectKey(dataKey, ctx.project) : dryRun ? randomBytes(32) : await writeKey(ctx.project, params);
  const result = await migrateEncrypt(params, key, { dryRun, purgeHistory });

  // Only a project with a sikrets.json can record the requirement; others are told how to add one.
  const marked = !dryRun && result.unreadable.length === 0 && result.changed.length === 0 && config.encryption !== ENCRYPTION_REQUIRED && (await hasConfig(root));
  if (marked) await writeConfig(root, { ...config, encryption: ENCRYPTION_REQUIRED });
  const required = marked || config.encryption === ENCRYPTION_REQUIRED;
  if (!dryRun) await record(root, { kind: "migrate", detail: `encrypt: ${result.sealed.length} sealed, ${result.already.length} already, ${result.unreadable.length} unreadable`, keys: result.sealed });

  if (opts.json) return console.log(JSON.stringify({ dryRun, ...result, required }));
  if (result.sealed.length) say(`${dryRun ? "Would encrypt" : "Encrypted"} ${result.sealed.length} value(s): ${result.sealed.join(", ")}`);
  if (result.already.length) say(`Already encrypted: ${result.already.length} value(s).`);
  if (result.purged.length) say(`Recreated ${result.purged.length} parameter(s) without their old versions.`);
  if (result.unreadable.length) say(`Not under this device's data key, left untouched: ${result.unreadable.join(", ")}. Restore the right key (sikrets recovery restore) or re-add them.`);
  if (result.changed.length) say(`Changed by someone else while this ran, left as they are: ${result.changed.join(", ")}. Run it again to include them.`);
  if (!result.sealed.length && !result.unreadable.length && !result.changed.length) say("Nothing to do: every value is already encrypted.");
  if (marked) say(`Plaintext values are now refused for "${ctx.project}" (sikrets.json "encryption": "${ENCRYPTION_REQUIRED}"). Commit sikrets.json.`);
  else if (!dryRun && !required && !result.unreadable.length) say(`To refuse plaintext from now on, run sikrets init and keep "encryption": "${ENCRYPTION_REQUIRED}".`);
  if (!dryRun && result.sealed.length && !purgeHistory) say("SSM still holds the old plaintext in each parameter's version history. Re-run with --purge-history to drop it, and rotate keys you can't vouch for.");
  if (!(await readRecord())) say("Your data key exists only on this device. Set up recovery now: sikrets recovery setup");
}
