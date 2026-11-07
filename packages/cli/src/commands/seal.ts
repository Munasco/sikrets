import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { envelopeKind } from "../core/envelope.ts";
import { externalKeys } from "../core/keys.ts";
import { standInKey } from "../core/standin.ts";
import { state } from "../core/state.ts";
import { isVaultKey, openVault } from "../core/vault.ts";
import { log } from "../ui.ts";

// `sikrets seal` seals values still stored as plaintext (written before client-side encryption).
// Reads refuse plaintext, because anyone who can write the backend could have planted it, so this
// is the one way it becomes trusted: on purpose, after the dry run shows which keys. Each write
// goes through only if the stored value is unchanged since it was read; a value rotated meanwhile
// is left alone and reported. A re-run picks up whatever is left.

type Action = "seal" | "sealed" | "newer";

export async function run(_args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const apply = Boolean(opts.apply);
  const say = (m: string) => log(opts, m);
  const { ctx } = await projectContext(root, { log: () => {} });
  const vault = await openVault(ctx.project, ctx.vault);

  // SSM can list the project's folder; the keychain can't, so it's the keys this project knows.
  const known = async () => {
    const { resources } = await state.load(root);
    const keys = [...resources.flatMap((r) => r.envKeys), ...(await externalKeys(root)).map((k) => k.key)];
    return [...keys, ...keys.map(standInKey)];
  };
  const names = [...new Set((await vault.store.list?.()) ?? (await known()))].filter(isVaultKey).sort();

  const rows: { key: string; action: Action; result?: "sealed" | "changed" }[] = [];
  for (const key of names) {
    const stored = await vault.store.getVersioned(key);
    if (!stored) continue;
    const kind = envelopeKind(stored.value);
    rows.push({ key, action: kind === "plain" ? "seal" : kind });
  }
  const todo = rows.filter((r) => r.action === "seal");

  if (apply && todo.length) {
    for (const row of todo) {
      const stored = await vault.store.getVersioned(row.key);
      if (!stored || envelopeKind(stored.value) !== "plain") {
        row.result = "changed";
        continue;
      }
      const sealed = vault.seal(row.key, await vault.writeKey(row.key), stored.value);
      row.result = (await vault.store.replaceIf(row.key, stored, sealed)) ? "sealed" : "changed";
    }
    const done = todo.filter((r) => r.result === "sealed").map((r) => r.key);
    if (done.length) await record(root, { kind: "seal", detail: `${done.length} value(s) sealed`, keys: done });
  }

  if (opts.json) return console.log(JSON.stringify({ apply, vault: vault.name, keys: rows }));
  if (!todo.length) return say(`Nothing to seal: every value in the ${vault.name} vault is encrypted.`);
  say(`${apply ? "Sealed" : "Would seal"} in the ${vault.name} vault (names only):`);
  for (const r of todo) say(`  ${r.result === "changed" ? "!" : "+"} ${r.key}${r.result === "changed" ? "  changed while sealing; left as is, run again" : ""}`);
  if (!apply) say("These are trusted as they are now. Check nothing unexpected is listed, then run: sikrets seal --apply");
}
