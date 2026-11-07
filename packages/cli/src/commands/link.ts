import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { assertNotPending, externalKeys, importExternalKeys, isPending, pushPending, unlinkKey } from "../core/keys.ts";
import { openVault } from "../core/vault.ts";
import { managerFor } from "../managers/index.ts";
import { log } from "../ui.ts";

// `sikrets link KEY <ref>` ties a project key to a password manager item: the item's current value
// is copied into the project vault, and every `sikrets rotate` writes the new value back to it.
// `sikrets link` lists links; `sikrets link KEY --remove` drops one (the vault value stays).
// `sikrets link --push` retries write-backs that failed, so items stop holding revoked values.
export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const [key, ref] = args;
  if (opts.push) {
    const { ctx } = await projectContext(root, { log: (s) => log(opts, s) });
    const vault = await openVault(ctx.project, ctx.server);
    const result = await pushPending(root, (k) => vault.get(k), (s) => log(opts, s));
    const failed = result.filter((r) => r.error);
    if (failed.length) process.exitCode = 1;
    if (opts.json) return console.log(JSON.stringify(result));
    return log(opts, result.length ? `Wrote back ${result.length - failed.length} of ${result.length} key(s).` : "Nothing pending; every linked item holds its key's current value.");
  }
  if (!key) {
    const linked = (await externalKeys(root)).filter((k) => k.ref);
    if (opts.json) return console.log(JSON.stringify(linked.map(({ key, ref, sync }) => ({ key, ref, sync: sync ?? { state: "synced" } }))));
    if (!linked.length) return console.log("No linked keys. Link one: sikrets link KEY bw://<item id>/password");
    for (const k of linked) console.log(`  ${k.key}  →  ${k.ref}${isPending(k) ? "  (write-back pending: sikrets link --push)" : ""}`);
    return;
  }
  if (opts.remove) {
    const removed = await unlinkKey(root, key, Boolean(opts.force));
    if (!removed) throw new Error(`${key} isn't linked`);
    return log(opts, `Unlinked ${key}; its value stays in the vault.`);
  }
  if (!ref) throw new Error("Missing <ref>. Usage: sikrets link KEY bw://<item id>/<field> | op://<vault>/<item>/<field>");

  const m = managerFor(ref);
  // Copying from an item whose write-back is pending would bring back a revoked value.
  assertNotPending(await externalKeys(root), [key], [ref]);
  const { ctx } = await projectContext(root, { log: (s) => log(opts, s) });
  const vault = await openVault(ctx.project, ctx.server);
  const value = await m.read(ref);
  const now = new Date().toISOString();
  await importExternalKeys(root, [{ key, source: m.id, ref, addedAt: now, sync: { state: "synced", at: now } }], () => vault.put(key, value));
  await record(root, { kind: "link", detail: `${m.name} ${ref}`, keys: [key] });
  if (opts.json) console.log(JSON.stringify({ key, ref, manager: m.id }));
  else log(opts, `Linked ${key} to ${m.name} (${ref}). Copied its current value into the vault on ${vault.server}; rotations write back to ${m.name}.`);
}
