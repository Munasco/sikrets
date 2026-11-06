import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { externalKeys, saveExternalKeys, unlinkKey } from "../core/keys.ts";
import { openVault } from "../core/vault.ts";
import { managerFor } from "../managers/index.ts";
import { log } from "../ui.ts";

// `sikrets link KEY <ref>` ties a project key to a password manager item: the item's current value
// is copied into the project vault, and every `sikrets rotate` writes the new value back to it.
// `sikrets link` lists links; `sikrets link KEY --remove` drops one (the vault value stays).
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const [key, ref] = args;
  if (!key) {
    const linked = (await externalKeys(root)).filter((k) => k.ref);
    if (opts.json) return console.log(JSON.stringify(linked.map(({ key, ref }) => ({ key, ref }))));
    if (!linked.length) return console.log("No linked keys. Link one: sikrets link KEY bw://<item id>/password");
    for (const k of linked) console.log(`  ${k.key}  →  ${k.ref}`);
    return;
  }
  if (opts.remove) {
    const removed = await unlinkKey(root, key);
    if (!removed) throw new Error(`${key} isn't linked`);
    return log(opts, `Unlinked ${key}; its value stays in the vault.`);
  }
  if (!ref) throw new Error("Missing <ref>. Usage: sikrets link KEY bw://<item id>/<field> | op://<vault>/<item>/<field>");

  const m = managerFor(ref);
  const { ctx } = await projectContext(root, { log: (s) => log(opts, s) });
  const vault = await openVault(ctx.project, ctx.server);
  const value = await m.read(ref);
  await vault.put(key, value);
  await saveExternalKeys(root, [{ key, source: m.id, ref, addedAt: new Date().toISOString() }]);
  await record(root, { kind: "link", detail: `${m.name} ${ref}`, keys: [key] });
  if (opts.json) console.log(JSON.stringify({ key, ref, manager: m.id }));
  else log(opts, `Linked ${key} to ${m.name} (${ref}). Copied its current value into the vault on ${vault.server}; rotations write back to ${m.name}.`);
}
