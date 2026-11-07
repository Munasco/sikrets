import { mkdir } from "node:fs/promises";
import { planAdd } from "../core/add.ts";
import { personalContext, personalDir } from "../core/config.ts";
import { record } from "../core/activity.ts";
import { applyPlan, printPlan } from "../core/plan.ts";
import { envValues } from "../core/standin.ts";
import { state } from "../core/state.ts";
import { sweepExpired } from "../core/sweep.ts";
import { after, parseDuration } from "../core/ttl.ts";
import { DEFAULTS } from "../constants.ts";
import { openVault } from "../core/vault.ts";
import { recipe } from "../recipes/index.ts";
import { log } from "../ui.ts";
import { readSecretInput } from "./secret-input.ts";

// `sikrets get <provider/service>`:
// Standalone resource minting outside any project. Credentials live in ~/.sikrets/orphans and
// print KEY=value pairs on stdout; all progress goes to stderr so $(sikrets get …) captures clean
// values. Each resource expires (default 24h, --expires to change): the next `get` or
// `status --personal` after that deletes it at the provider, like `rollback --personal` would.
export async function run(args: string[], opts: Record<string, unknown>) {
  if (!args[0]) throw new Error("Usage: sikrets get <provider/service>");
  const r = recipe(args[0]);
  if (r.strategy === "terraform") {
    throw new Error(`${r.id} is managed by Terraform and cannot be fetched standalone; use "sikrets add" in a project instead`);
  }

  await mkdir(personalDir(), { recursive: true });
  const { config, ctx } = await personalContext({
    dryRun: Boolean(opts["dry-run"]),
    log: (m) => log(opts, m),
  });

  if (!ctx.dryRun) await sweepExpired(ctx);
  const { resources } = await state.load(ctx.root);
  const vault = await openVault(ctx.project, ctx.vault);

  // If a resource with this explicit name exists, reuse its credentials instead of creating another.
  if (typeof opts.name === "string") {
    const existing = resources.find((x) => x.name === opts.name);
    if (existing) {
      if (existing.recipe !== r.id) {
        throw new Error(`Resource "${opts.name}" already exists but is a ${existing.recipe}, not ${r.id}`);
      }
      if (!existing.applied) throw new Error(`${existing.name} is not live yet`);
      const values = await envValues(vault, [existing], Boolean(opts.real));
      await record(ctx.root, { kind: "get", detail: `${r.id} ${existing.name}`, keys: [...values.keys()], real: Boolean(opts.real) });
      output(values, Boolean(opts.json));
      return;
    }
  }

  const taken = new Set(resources.map((x) => x.name));
  let name = typeof opts.name === "string" ? opts.name : undefined;
  if (!name) {
    const base = r.defaultName ?? r.id.split("/")[1]!;
    if (!taken.has(base)) {
      name = base;
    } else {
      let i = 2;
      while (taken.has(`${base}-${i}`)) i++;
      name = `${base}-${i}`;
    }
  }

  const inputs = pairs(opts.set, "--set");
  const unknown = Object.keys(inputs).filter((k) => !(k in r.inputs));
  if (unknown.length) throw new Error(`${r.id} has no input ${unknown.join(", ")}. Inputs: ${Object.keys(r.inputs).join(", ") || "none"}`);

  const expires = typeof opts.expires === "string" ? opts.expires : DEFAULTS.getExpires;
  if (expires !== "never") parseDuration(expires);

  const plan = await planAdd(
    {
      recipe: r.id,
      name,
      inputs,
      use: {},
      choose: async (question) => {
        throw new Error(`${question} Dependencies cannot be prompted in get; add them first or use sikrets add`);
      },
      envFile: config.env,
      rotateEvery: config.rotateEvery,
      secret: (prompt) => readSecretInput(opts, prompt),
    },
    ctx,
  );

  // Only the requested resource expires; dependencies planned for it may be shared later.
  const created = plan.resources.find((x) => x.name === name) ?? plan.resources[0]!;
  if (expires !== "never") Object.assign(created, { expires, expiresAt: after(expires) });

  if (ctx.dryRun) {
    printPlan(plan.changes, ctx);
    if (created.expiresAt) ctx.log(`  Deleted after ${expires} (${created.expiresAt})`);
    if (opts.json) {
      console.log(
        JSON.stringify({
          dryRun: true,
          resources: plan.resources.map(({ name, recipe, inputs, dependsOn }) => ({ name, recipe, inputs, dependsOn })),
          changes: plan.changes.map(({ summary, cost }) => ({ summary, cost })),
        }),
      );
    }
    return;
  }

  await applyPlan(`get ${r.id}`, plan.changes, ctx);
  const values = await envValues(vault, [{ ...created, applied: true }], Boolean(opts.real));
  await record(ctx.root, { kind: "get", detail: `${r.id} ${name}`, keys: [...values.keys()], real: Boolean(opts.real) });
  output(values, Boolean(opts.json));
}

function output(values: ReadonlyMap<string, { reveal: () => string }>, json: boolean) {
  if (json) {
    const obj: Record<string, string> = {};
    for (const [k, v] of values) obj[k] = v.reveal();
    console.log(JSON.stringify(obj));
  } else {
    for (const [k, v] of values) {
      console.log(`${k}=${v.reveal()}`);
    }
  }
}

function pairs(value: unknown, flag: string): Record<string, string> {
  const list = value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
  return Object.fromEntries(
    list.map((item) => {
      const i = item.indexOf("=");
      if (i <= 0) throw new Error(`${flag} expects key=value, got "${item}"`);
      return [item.slice(0, i), item.slice(i + 1)];
    }),
  );
}
