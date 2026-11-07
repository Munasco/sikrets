import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { providerEnv } from "../core/credentials.ts";
import { Secret } from "../core/secret.ts";
import path from "node:path";
import { withLock } from "../core/fs.ts";
import { state, type Resource } from "../core/state.ts";
import { parseExpiry, schedule } from "../core/schedule.ts";
import { openVault } from "../core/vault.ts";
import { recipe } from "../recipes/index.ts";
import { envPrefix, type Recipe } from "../recipes/types.ts";
import { confirm, log } from "../ui.ts";
import type { Context } from "../core/plan.ts";
import { FILES, keychainRecoveryService, LOCK, PROJECT_DIR } from "../constants.ts";
import { revokeHints } from "../store.ts";
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

type Ctx = Awaited<ReturnType<typeof projectContext>>;

export interface RotateResult {
  resource: string;
  keys: string[];
  rotated: boolean;
  rotateBy?: string;
  expiresAt?: string;
  revokeOld?: string;
}

/**
 * Rotates one live resource; also used for auto-rotation. Holds the project's rotation lock for
 * the whole rotation and re-reads the resource once it has it, so two processes never rotate the
 * same key (the loser would store a credential the winner's rotation already revoked). With
 * `onlyIfDue`, a resource another process rotated meanwhile is left alone.
 */
export async function rotateOne(name: string, project: Ctx, opts: Record<string, unknown>, say: (m: string) => void, onlyIfDue?: (r: Resource) => boolean): Promise<RotateResult> {
  return withLock(rotationLock(project.ctx.root), async () => {
    const res = (await state.load(project.ctx.root)).resources.find((r) => r.name === name);
    if (!res) throw new Error(`No resource named "${name}" in this project. See: sikrets status`);
    if (!res.applied) throw new Error(`${res.name} isn't live yet`);
    if (onlyIfDue && !onlyIfDue(res)) return { resource: res.name, keys: [], rotated: false };
    return rotateLocked(res, project, opts, say);
  }, LOCK.rotationWaitMs);
}

const rotationLock = (root: string) => path.join(root, PROJECT_DIR, FILES.rotation);

async function rotateLocked(res: Resource, { config, ctx }: Ctx, opts: Record<string, unknown>, say: (m: string) => void): Promise<RotateResult> {
  const r = recipe(res.recipe);
  // A rotation whose new credential is already saved locally only needs copying into the vault.
  const resume = res.rotation?.status === "issued" ? res.rotation : undefined;
  const plan = resume ? undefined : rotator(r, res, opts, say);
  const keys = Object.entries(r.outputs).filter(([, o]) => o.sensitive).map(([, o]) => `${envPrefix(res.name)}_${o.env}`);
  const vaultName = res.vault ?? ctx.vault;
  // Dashboard keys get whatever expiry the person picks again; API keys keep the provider's.
  const asked = typeof opts.expires === "string" ? parseExpiry(opts.expires) : undefined;
  if (asked && r.strategy !== "manual") throw new Error(`--expires on rotate is for dashboard keys; ${r.id} keys expire as the provider decides`);
  const expires = asked ? (asked === "never" ? undefined : asked) : res.expires;

  say(`${ctx.dryRun ? "Dry run — would rotate" : "Rotating"} "${res.name}" (${r.id}):`);
  if (resume) say(`  ~ Finish the rotation started ${resume.at}: its new credential is saved locally but not yet in the vault`);
  else {
    if (res.rotation?.status === "requested") say(`  ! The rotation started ${res.rotation.at} stopped before its new credential was saved; this replaces it`);
    say(`  ~ ${plan!.describe}`);
  }
  say(`  ~ Replace ${keys.join(", ")} in the ${vaultName} vault (stand-ins stay the same)`);
  if (r.strategy === "manual" && !asked && expires) say(`  ~ Assuming the new key also expires after ${expires}; pass --expires if you picked something else (or never)`);
  say(`  ~ Next rotation due in ${config.rotateEvery}${expires ? `, or before the new key's ${expires} expiry` : ""}`);
  if (ctx.dryRun) return { resource: res.name, keys, rotated: false };
  if (!resume && !opts.yes && process.stdin.isTTY && !(await confirm("Rotate now? The old credential will stop working."))) {
    say("Skipped; nothing changed.");
    return { resource: res.name, keys, rotated: false };
  }

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
  const next = schedule(config.rotateEvery, expires);
  await state.patch(ctx, res.name, ({ rotation: _, expires: __, expiresAt: ___, ...cur }) => ({
    ...cur,
    outputs,
    lastRotatedAt: now,
    ...(expires ? { expires } : {}),
    ...next,
    ...(old ? { oldKey: { replacedAt: now } } : {}),
  }));
  if (old) await revokeHints.set(ctx.project, res.name, old.hint());
  await recovery.clear(ctx.project, res.name, Object.keys(changed));
  await record(ctx.root, { kind: "rotate", detail: `${r.id} ${res.name}`, keys });
  say(`  Rotated ${keys.join(", ")}.`);
  if (old && r.strategy === "manual") say(`  Revoke the old key (${old.hint()}) at ${r.instructions.url}, then run: sikrets rotate ${res.name} --revoked`);
  return { resource: res.name, keys, rotated: true, ...next, ...(old ? { revokeOld: old.hint() } : {}) };
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const say = (m: string) => log(opts, m);
  const project = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: say });
  if (opts.revoked) {
    const res = (await state.load(root)).resources.find((r) => r.name === args[0]);
    if (!res) throw new Error(`No resource named "${args[0]}" in this project. See: sikrets status`);
    return markRevoked(res, project.ctx, opts, say);
  }

  const result = await rotateOne(args[0]!, project, opts, say);
  if (opts.json) console.log(JSON.stringify(result));
  else if (result.rotated) say("Stand-ins are unchanged; apps using @sikrets/sdk pick up new values within its cache window, `sikrets run` on next start.");
}

/** The person revoked the replaced dashboard key; stop reminding them. */
async function markRevoked(res: Resource, ctx: Context, opts: Record<string, unknown>, say: (m: string) => void) {
  if (!res.oldKey) return say(`${res.name} has no replaced key waiting to be revoked.`);
  const hint = await revokeHints.get(ctx.project, res.name);
  await state.patch(ctx, res.name, ({ oldKey: _, ...cur }) => cur);
  await revokeHints.delete(ctx.project, res.name);
  if (opts.json) console.log(JSON.stringify({ resource: res.name, revoked: true, ...(hint ? { hint } : {}) }));
  else say(`Noted: the old key${hint ? ` ${hint}` : ""} for ${res.name} is revoked.`);
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
