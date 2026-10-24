import { record } from "../core/activity.ts";
import { projectContext } from "../core/config.ts";
import { providerEnv } from "../core/credentials.ts";
import { Secret } from "../core/secret.ts";
import { state, type Resource } from "../core/state.ts";
import { schedule } from "../core/schedule.ts";
import { openVault } from "../core/vault.ts";
import { recipe } from "../recipes/index.ts";
import { envPrefix, type Recipe } from "../recipes/types.ts";
import { confirm, log } from "../ui.ts";
import { readSecretInput } from "./secret-input.ts";

// Replaces a resource's credential with a new one. Stand-ins stay the same, so .env files and
// hosting platforms need no change; apps using @sikrets/sdk pick up the new value within its cache
// window, and processes under `sikrets run` on their next start. Not reversible: the old credential
// is revoked (API recipes) or should be revoked in the dashboard (manual recipes).

type Rotator = { describe: string; run: () => Promise<Record<string, string | Secret>> };

function rotator(r: Recipe, res: Resource, opts: Record<string, unknown>, say: (m: string) => void): Rotator {
  switch (r.strategy) {
    case "api": {
      if (!r.rotate || !res.remoteId) throw new Error(`${r.id} can't be rotated through its API; remove and re-add it instead`);
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

/** Rotates one live resource; also used for auto-rotation. */
export async function rotateOne(res: Resource, { config, ctx }: Ctx, opts: Record<string, unknown>, say: (m: string) => void) {
  const r = recipe(res.recipe);
  const plan = rotator(r, res, opts, say);
  const keys = Object.entries(r.outputs).filter(([, o]) => o.sensitive).map(([, o]) => `${envPrefix(res.name)}_${o.env}`);
  const { expires } = res;

  say(`${ctx.dryRun ? "Dry run — would rotate" : "Rotating"} "${res.name}" (${r.id}):`);
  say(`  ~ ${plan.describe}`);
  say(`  ~ Replace ${keys.join(", ")} in the ${ctx.vault} vault (stand-ins stay the same)`);
  say(`  ~ Next rotation due in ${config.rotateEvery}${expires ? `, or before the new key's ${expires} expiry` : ""}`);
  if (ctx.dryRun) return { resource: res.name, keys, rotated: false };
  if (!opts.yes && process.stdin.isTTY && !(await confirm("Rotate now? The old credential will stop working."))) {
    say("Skipped; nothing changed.");
    return { resource: res.name, keys, rotated: false };
  }

  const changed = await plan.run();
  const vault = await openVault(ctx.project, ctx.vault);
  const outputs = { ...res.outputs };
  for (const [key, value] of Object.entries(changed)) {
    const spec = r.outputs[key];
    if (!spec) throw new Error(`${r.id} returned an unknown output "${key}"`);
    if (spec.sensitive && !(value instanceof Secret)) throw new Error(`${r.id} returned ${key} unwrapped; sensitive outputs must be Secret`);
    await vault.put(`${envPrefix(res.name)}_${spec.env}`, value instanceof Secret ? value : Secret.of(value));
    if (typeof value === "string") outputs[key] = value;
  }
  const next = schedule(config.rotateEvery, expires);
  await state.upsert(ctx.root, { ...res, outputs, lastRotatedAt: new Date().toISOString(), ...next });
  await record(ctx.root, { kind: "rotate", detail: `${r.id} ${res.name}`, keys });
  say(`  Rotated ${keys.join(", ")}.${r.strategy === "manual" ? ` Revoke the old key at ${r.instructions.url}.` : ""}`);
  return { resource: res.name, keys, rotated: true, ...next };
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const root = process.cwd();
  const say = (m: string) => log(opts, m);
  const project = await projectContext(root, { dryRun: Boolean(opts["dry-run"]), log: say });
  const res = (await state.load(root)).resources.find((r) => r.name === args[0]);
  if (!res) throw new Error(`No resource named "${args[0]}" in this project. See: sikrets status`);
  if (!res.applied) throw new Error(`${res.name} isn't live yet`);

  const result = await rotateOne(res, project, opts, say);
  if (opts.json) console.log(JSON.stringify(result));
  else if (result.rotated) say("Stand-ins are unchanged; apps using @sikrets/sdk pick up new values within its cache window, `sikrets run` on next start.");
}
