import { files, GITIGNORE, moduleTf, rootTf, versionsTf } from "../iac/terraform.ts";
import { recipe, terraformRecipe } from "../recipes/index.ts";
import { envPrefix, resolveInputs, RESOURCE_NAME, type ApiRecipe, type ManualRecipe, type Provisioned, type Recipe, type TerraformRecipe } from "../recipes/types.ts";
import { providerEnv } from "./credentials.ts";
import { removeEnv, upsertEnv } from "./dotenv.ts";
import { ensureGitignore, isGenerated, removeGenerated, writeGenerated } from "./files.ts";
import { registerUndo, type Change, type Context } from "./plan.ts";
import { Secret } from "./secret.ts";
import { envValues, outputKeys, standInKey } from "./standin.ts";
import { after } from "./ttl.ts";
import { state, type Resource } from "./state.ts";
import { openVault } from "./vault.ts";

export interface AddRequest {
  recipe: string;
  name: string;
  inputs: Readonly<Record<string, string | undefined>>;
  /** Explicit dependency choices, requirement name → existing resource name. */
  use: Readonly<Record<string, string>>;
  /** Asked only when several existing resources could satisfy a requirement. */
  choose: (question: string, options: readonly string[]) => Promise<string>;
  /** Reads a credential the person pastes (manual recipes). Called only when the change is applied. */
  secret: (prompt: string) => Promise<Secret>;
  /** Env file stand-ins are written to (from sikrets.json); defaults to .env. */
  envFile?: string;
  /** Rotation interval for credentials Sikrets provisions (from sikrets.json). */
  rotateEvery?: string;
}

export interface AddPlan {
  /** New resources in creation order: dependencies first. */
  resources: Resource[];
  changes: Change[];
}

/**
 * Turns "add X" into concrete, reversible changes. Dependencies are resolved deterministically:
 * an explicit --use wins, then a single existing match is reused, then several matches are put to
 * the user, and with none a new dependency is planned with its defaults.
 */
export async function planAdd(req: AddRequest, ctx: Context): Promise<AddPlan> {
  const existing = (await state.load(ctx.root)).resources;
  const planned: Resource[] = [];
  const taken = new Set(existing.map((r) => r.name));

  const plan = async (r: Recipe, name: string, given: AddRequest["inputs"], use: AddRequest["use"]): Promise<Resource> => {
    if (!RESOURCE_NAME.test(name)) throw new Error(`Invalid name "${name}": use lowercase letters, digits and dashes`);
    if (taken.has(name)) throw new Error(`This project already has a resource named "${name}"`);
    taken.add(name);

    const dependsOn: Record<string, string> = {};
    for (const reqd of r.requires) {
      const candidates = [...existing, ...planned].filter((x) => x.recipe === reqd.recipe).map((x) => x.name);
      const chosen = use[reqd.as];
      if (chosen) {
        if (!candidates.includes(chosen)) throw new Error(`--use ${reqd.as}=${chosen}: no ${reqd.recipe} named "${chosen}" in this project`);
        dependsOn[reqd.as] = chosen;
      } else if (candidates.length === 1) {
        dependsOn[reqd.as] = candidates[0]!;
      } else if (candidates.length > 1) {
        dependsOn[reqd.as] = await req.choose(`${r.id} needs a ${reqd.recipe} (${reqd.as}). Which one?`, candidates);
      } else {
        const depName = taken.has(reqd.as) ? `${name}-${reqd.as}` : reqd.as;
        dependsOn[reqd.as] = (await plan(recipe(reqd.recipe), depName, {}, {})).name;
      }
    }

    const resource: Resource = {
      name,
      recipe: r.id,
      provider: r.provider,
      strategy: r.strategy,
      inputs: resolveInputs(r, given),
      dependsOn,
      envKeys: Object.values(r.outputs).map((o) => `${envPrefix(name)}_${o.env}`),
      outputs: {},
      applied: false,
      createdAt: new Date().toISOString(),
      // Terraform-managed credentials rotate through Terraform; the rest get a due date.
      ...(r.strategy !== "terraform" && req.rotateEvery ? { rotateBy: after(req.rotateEvery) } : {}),
    };
    planned.push(resource);
    return resource;
  };

  await plan(recipe(req.recipe), req.name, req.inputs, req.use);
  return { resources: planned, changes: await changesFor(planned, existing, ctx, req.secret, req.envFile ?? ".env") };
}

async function changesFor(planned: readonly Resource[], existing: readonly Resource[], ctx: Context, read: AddRequest["secret"], envFile: string): Promise<Change[]> {
  const all = [...existing, ...planned];
  const changes: Change[] = [];

  // versions.tf goes first so its undo runs last, after the state no longer lists these resources.
  if (planned.some((r) => r.strategy === "terraform")) {
    const providers = [...new Set(all.filter((r) => r.strategy === "terraform").map((r) => terraformRecipe(r.recipe).terraformProvider))];
    changes.push({
      summary: `Update ${files.versions} (providers: ${providers.join(", ")})`,
      async apply(c) {
        await ensureGitignore(c.root, GITIGNORE);
        await writeGenerated(c.root, files.versions, versionsTf(all));
        return { kind: "terraform.versions", summary: `Regenerate ${files.versions}`, data: {} };
      },
    });
  }

  const newModules = new Set<string>();
  for (const res of planned) {
    const r = recipe(res.recipe);
    if (r.strategy === "api") changes.push(...apiChanges(r, res), envFileChange(res, envFile));
    else if (r.strategy === "manual") changes.push(...manualChanges(r, res, read), envFileChange(res, envFile));
    else {
      const [main] = files.module(r);
      if (!newModules.has(r.id) && !(await isGenerated(ctx.root, main))) {
        newModules.add(r.id);
        changes.push(moduleChange(r));
      }
      changes.push(...terraformChanges(r, res));
    }
  }
  return changes;
}

/** Writes this resource's keys into the project's .env: stand-ins for secrets, real values for the rest. */
function envFileChange(res: Resource, file: string): Change {
  const keys = outputKeys(res);
  return {
    summary: `Write ${keys.map((k) => `${k.key}${k.sensitive ? " (stand-in)" : ""}`).join(", ")} to ${file}`,
    async apply(c) {
      const vault = await openVault(c.project, c.vault);
      await upsertEnv(c.root, file, await envValues(vault, [{ ...res, applied: true }], false));
      const standIns = keys.filter((k) => k.sensitive).map((k) => standInKey(k.key));
      return {
        kind: "env.unwrite",
        summary: `Remove ${keys.map((k) => k.key).join(", ")} from ${file} and drop their stand-ins`,
        data: { project: c.project, file: file, keys: keys.map((k) => k.key).join(","), standIns: standIns.join(",") },
      };
    },
  };
}

/** The person creates the credential in the dashboard; it is checked, then stored. Nothing is stored if a check fails. */
function manualChanges(r: ManualRecipe, res: Resource, read: AddRequest["secret"]): Change[] {
  const spec = r.outputs[r.secret];
  if (!spec?.sensitive) throw new Error(`${r.id}: secret output "${r.secret}" must be declared sensitive`);
  const key = `${envPrefix(res.name)}_${spec.env}`;
  return [
    {
      summary: `Ask for ${spec.description} (create it at ${r.instructions.url}), verify it, store it as ${key}`,
      cost: r.estimate(res.inputs),
      async apply(c) {
        c.log(`  Create it at ${r.instructions.url}:`);
        for (const [i, s] of r.instructions.steps.entries()) c.log(`    ${i + 1}. ${s}`);
        const value = await read(`${spec.description}: `);
        if (!r.pattern.test(value.reveal())) throw new Error(`That doesn't look like ${spec.description.replace(/^an? /i, "an ")}; nothing was stored`);
        await r.verify(value);
        await (await openVault(c.project, c.vault)).put(key, value);
        c.log(`  Verified with ${r.provider} and stored as ${key}`);
        return { kind: "vault.delete", summary: `Remove ${key} from the vault`, data: { project: c.project, keys: key } };
      },
    },
    {
      summary: `Record "${res.name}" in .sikrets/state.json`,
      async apply(c) {
        await state.upsert(c.root, { ...res, applied: true });
        return { kind: "state.remove", summary: `Forget "${res.name}" (revoke the key itself at ${r.instructions.url})`, data: { name: res.name } };
      },
    },
  ];
}

/** Created right away through the provider's API; outputs go straight to the vault. */
function apiChanges(r: ApiRecipe, res: Resource): Change[] {
  let created: Provisioned | undefined;
  const made = () => {
    if (!created) throw new Error(`${res.name} wasn't created`);
    return created;
  };
  return [
    {
      summary: `Create ${r.id} "${res.name}" at ${r.provider}`,
      cost: r.estimate(res.inputs),
      async apply() {
        created = await r.create(await providerEnv([r.provider]), res.name, res.inputs);
        return { kind: "api.destroy", summary: `Delete ${r.id} "${res.name}" at ${r.provider}`, data: { recipe: r.id, remoteId: created.remoteId } };
      },
    },
    {
      summary: `Store ${res.envKeys.join(", ")} in the vault`,
      async apply(c) {
        const vault = await openVault(c.project, c.vault);
        for (const [key, spec] of Object.entries(r.outputs)) {
          const value = made().outputs[key];
          if (value === undefined) throw new Error(`${r.id} returned no ${key}`);
          if (spec.sensitive && !(value instanceof Secret)) throw new Error(`${r.id} returned ${key} unwrapped; sensitive outputs must be Secret`);
          await vault.put(`${envPrefix(res.name)}_${spec.env}`, value instanceof Secret ? value : Secret.of(value));
        }
        return { kind: "vault.delete", summary: `Remove ${res.envKeys.join(", ")} from the vault`, data: { project: c.project, keys: res.envKeys.join(",") } };
      },
    },
    {
      summary: `Record "${res.name}" in .sikrets/state.json`,
      async apply(c) {
        const visible = Object.fromEntries(Object.entries(made().outputs).filter((e): e is [string, string] => typeof e[1] === "string"));
        await state.upsert(c.root, { ...res, remoteId: made().remoteId, outputs: visible, applied: true });
        return { kind: "state.remove", summary: `Forget "${res.name}"`, data: { name: res.name } };
      },
    },
  ];
}

function moduleChange(r: TerraformRecipe): Change {
  const [main] = files.module(r);
  return {
    summary: `Generate module ${main.slice(0, main.lastIndexOf("/"))}/`,
    async apply(c) {
      const contents = moduleTf(r);
      for (const [i, path] of files.module(r).entries()) await writeGenerated(c.root, path, contents[i]!);
      return { kind: "module.release", summary: `Remove module for ${r.id} if nothing else uses it`, data: { recipe: r.id } };
    },
  };
}

/** Declared as Terraform now; created in the cloud by `sikrets apply`. */
function terraformChanges(r: TerraformRecipe, res: Resource): Change[] {
  const deps = Object.entries(res.dependsOn).map(([as, n]) => `${as} → ${n}`);
  return [
    {
      summary: `${r.id} "${res.name}"${deps.length ? ` (${deps.join(", ")})` : ""} → ${files.root(res.name)}`,
      cost: r.estimate(res.inputs),
      async apply(c) {
        await writeGenerated(c.root, files.root(res.name), rootTf(res));
        return { kind: "file.delete", summary: `Remove ${files.root(res.name)}`, data: { path: files.root(res.name) } };
      },
    },
    {
      summary: `Record "${res.name}" in .sikrets/state.json (publishes ${res.envKeys.join(", ")} after apply)`,
      async apply(c) {
        await state.upsert(c.root, res);
        return { kind: "state.remove", summary: `Forget "${res.name}"`, data: { name: res.name } };
      },
    },
  ];
}

registerUndo("api.destroy", async ({ recipe: id, remoteId }) => {
  const r = recipe(id!);
  if (r.strategy !== "api") throw new Error(`${id} isn't an API recipe`);
  await r.destroy(await providerEnv([r.provider]), remoteId!);
});

registerUndo("env.unwrite", async ({ project, file, keys, standIns }, ctx) => {
  await removeEnv(ctx.root, file!, keys!.split(","));
  const vault = await openVault(project!, ctx.vault);
  for (const key of standIns ? standIns.split(",") : []) await vault.delete(key);
});

registerUndo("state.remove", async ({ name }, ctx) => state.remove(ctx.root, name!));

registerUndo("terraform.versions", async (_, ctx) => {
  const { resources } = await state.load(ctx.root);
  if (resources.some((r) => r.strategy === "terraform")) await writeGenerated(ctx.root, files.versions, versionsTf(resources));
  else await removeGenerated(ctx.root, files.versions, ctx);
});

registerUndo("module.release", async ({ recipe: id }, ctx) => {
  const { resources } = await state.load(ctx.root);
  if (resources.some((r) => r.recipe === id)) return;
  for (const path of files.module(terraformRecipe(id!))) await removeGenerated(ctx.root, path, ctx);
});
