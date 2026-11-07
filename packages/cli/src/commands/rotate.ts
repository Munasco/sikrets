import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { providerEnv } from "../core/credentials.ts";
import { Secret } from "../core/secret.ts";
import { state, type Resource } from "../core/state.ts";
import { after } from "../core/ttl.ts";
import { openVault } from "../core/vault.ts";
import { recipe } from "../recipes/index.ts";
import { envPrefix, type Recipe } from "../recipes/types.ts";
import { confirm, log } from "../ui.ts";
import type { Context } from "../core/plan.ts";
import { keychainRecoveryService } from "../constants.ts";
import { readSecretInput } from "./secret-input.ts";

// Replaces a resource's credential with a new one. Stand-ins stay the same, so .env files and
// hosting platforms need no change; apps using @sikrets/sdk pick up the new value within its cache
// window, and processes under `sikrets run` on their next start. Not reversible: the old credential
// is revoked (API recipes) or should be revoked in the dashboard (manual recipes).
// Crash-safe order: check the vault takes writes → mark the rotation requested → ask the provider →
// save the new credential in the local recovery keychain (issued) → write the vault → clear the
// mark. A re-run after a failure resumes from the mark instead of revoking the new key too.

type Rotator = { describe: string; run: () => Promise<Record<string, string | Secret>> };

function rotator(r: Recipe, res: Resource, opts: Record<string, unknown>, say: (m: string) => void): Rotator {
  switch (r.strategy) {
    case "api": {
      if (!r.rotate) throw new Error(`${r.id} can't be rotated through its API; remove and re-add it instead`);
      if (!res.remoteId) throw new Error(`.sikrets/state.json has no provider id for ${res.name} (hand-edited or corrupt); remove it and add it again`);
      const { rotate } = r;
      const id = res.remoteId;
      return { describe: `Ask ${r.provider} for a new credential (the old one stops working immediately)`, run: async () => rotate(await providerEnv([r.provider]), id) };
    }
    case "manual": {
      const spec = r.outputs[r.secret]!;
      return {
        describe: `Ask for a replacement ${spec.description}, verify it, then swap it in`,
        run: async () => {
          say(`  Create the replacement at ${r.instructions.url}:`);
          for (const [i, s] of r.instructions.steps.entries()) say(`    ${i + 1}. ${s}`);
          const value = await readSecretInput(opts, `New ${spec.description}: `);
          if (!r.pattern.test(value.reveal())) throw new Error(`That doesn't look like ${spec.description}; nothing changed`);
          await r.verify(value);
          return { [r.secret]: value };
        },
      };
    }
    case "terraform":
      throw new Error(`${res.name} is managed by Terraform; rotate it there (e.g. terraform apply -replace=…), then sikrets apply`);
  }
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const say = (m: string) => log(opts, m);
  const { config, ctx } = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: say });
  const res = (await state.load(root)).resources.find((r) => r.name === args[0]);
  if (!res) throw new Error(`No resource named "${args[0]}" in this project. See: sikrets status`);
  if (!res.applied) throw new Error(`${res.name} isn't live yet`);
  if (opts.revoked) return markRevoked(res, ctx, opts, say);
  const r = recipe(res.recipe);
  // A rotation whose new credential is already saved locally only needs copying into the vault.
  const resume = res.rotation?.status === "issued" ? res.rotation : undefined;
  const plan = resume ? undefined : rotator(r, res, opts, say);
  const keys = Object.entries(r.outputs).filter(([, o]) => o.sensitive).map(([, o]) => `${envPrefix(res.name)}_${o.env}`);
  const vaultName = res.vault ?? ctx.vault;

  say(`${ctx.dryRun ? "Dry run — would rotate" : "Rotating"} "${res.name}" (${r.id}):`);
  if (resume) say(`  ~ Finish the rotation started ${resume.at}: its new credential is saved locally but not yet in the vault`);
  else {
    if (res.rotation?.status === "requested") say(`  ! The rotation started ${res.rotation.at} stopped before its new credential was saved; this replaces it`);
    say(`  ~ ${plan!.describe}`);
  }
  say(`  ~ Replace ${keys.join(", ")} in the ${vaultName} vault (stand-ins stay the same)`);
  say(`  ~ Next rotation due ${config.rotateEvery} after this`);
  if (ctx.dryRun) return opts.json ? console.log(JSON.stringify({ dryRun: true, resource: res.name, keys })) : undefined;
  if (!resume && !opts.yes && process.stdin.isTTY && !(await confirm("Rotate now? The old credential will stop working."))) return say("Cancelled; nothing changed.");

  const vault = await openVault(ctx.project, vaultName);
  // Before the provider revokes anything, prove the vault takes writes (an expired AWS session
  // fails here, with the old credential still working).
  for (const key of keys) {
    const current = await vault.get(key);
    if (current) await vault.put(key, current);
  }
  const old = r.strategy === "manual" ? await vault.get(`${envPrefix(res.name)}_${r.outputs[r.secret]!.env}`) : undefined;

  let changed: Record<string, string | Secret>;
  if (resume) changed = await recovery.load(ctx.project, res.name, r, resume.outputs ?? []);
  else {
    await state.patch(ctx, res.name, (cur) => ({ ...cur, rotation: { status: "requested", at: new Date().toISOString() } }));
    changed = await plan!.run();
    for (const [key, value] of Object.entries(changed)) {
      const spec = r.outputs[key];
      if (!spec) throw new Error(`${r.id} returned an unknown output "${key}"`);
      if (spec.sensitive && !(value instanceof Secret)) throw new Error(`${r.id} returned ${key} unwrapped; sensitive outputs must be Secret`);
    }
    // The old credential may be dead now, so keep the new one somewhere durable before the vault.
    try {
      await recovery.save(ctx.project, res.name, changed);
      await state.patch(ctx, res.name, (cur) => ({ ...cur, rotation: { status: "issued", at: cur.rotation?.at ?? new Date().toISOString(), outputs: Object.keys(changed) } }));
    } catch (error) {
      say(`  ! Couldn't save the new credential locally (${error instanceof Error ? error.message : String(error)}); writing it to the vault directly`);
    }
  }

  const outputs = { ...res.outputs };
  for (const [key, value] of Object.entries(changed)) {
    await vault.put(`${envPrefix(res.name)}_${r.outputs[key]!.env}`, value instanceof Secret ? value : Secret.of(value));
    if (typeof value === "string") outputs[key] = value;
  }
  const now = new Date().toISOString();
  await state.patch(ctx, res.name, ({ rotation: _, ...cur }) => ({
    ...cur,
    outputs,
    lastRotatedAt: now,
    rotateBy: after(config.rotateEvery),
    ...(old ? { oldKey: { hint: old.hint(), replacedAt: now } } : {}),
  }));
  await recovery.clear(ctx.project, res.name, Object.keys(changed));
  await record(root, { kind: "rotate", detail: `${r.id} ${res.name}`, keys });

  if (opts.json) console.log(JSON.stringify({ resource: res.name, rotated: keys, rotateBy: after(config.rotateEvery), ...(old ? { revokeOld: old.hint() } : {}) }));
  else {
    say(`Rotated ${keys.join(", ")}. Stand-ins unchanged; apps using @sikrets/sdk pick it up within its cache window, \`sikrets run\` on next start.`);
    if (old && r.strategy === "manual") say(`Revoke the old key (${old.hint()}) at ${r.instructions.url}, then run: sikrets rotate ${res.name} --revoked`);
  }
}

/** The person revoked the replaced dashboard key; stop reminding them. */
async function markRevoked(res: Resource, ctx: Context, opts: Record<string, unknown>, say: (m: string) => void) {
  if (!res.oldKey) return say(`${res.name} has no replaced key waiting to be revoked.`);
  await state.patch(ctx, res.name, ({ oldKey: _, ...cur }) => cur);
  if (opts.json) console.log(JSON.stringify({ resource: res.name, revoked: res.oldKey.hint }));
  else say(`Noted: the old key ${res.oldKey.hint} for ${res.name} is revoked.`);
}

/** Rotated credentials, held in the local keychain only until they are in the project's vault. */
const recovery = {
  name: (resource: string, output: string) => `${resource}/${output}`,
  async save(project: string, resource: string, values: Record<string, string | Secret>) {
    for (const [key, value] of Object.entries(values)) {
      await Bun.secrets.set({ service: keychainRecoveryService(project), name: recovery.name(resource, key), value: value instanceof Secret ? value.reveal() : value });
    }
  },
  async load(project: string, resource: string, r: Recipe, outputs: readonly string[]): Promise<Record<string, string | Secret>> {
    const out: Record<string, string | Secret> = {};
    for (const key of outputs) {
      const value = await Bun.secrets.get({ service: keychainRecoveryService(project), name: recovery.name(resource, key) });
      if (!value) throw new Error(`The saved credential for ${resource} is gone from the keychain; rotate again from scratch`);
      out[key] = r.outputs[key]?.sensitive ? Secret.of(value) : value;
    }
    return out;
  },
  async clear(project: string, resource: string, outputs: readonly string[]) {
    for (const key of outputs) await Bun.secrets.delete({ service: keychainRecoveryService(project), name: recovery.name(resource, key) }).catch(() => false);
  },
};
