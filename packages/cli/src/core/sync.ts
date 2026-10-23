import { outputName } from "../iac/terraform.ts";
import { terraformRecipe } from "../recipes/index.ts";
import { envPrefix } from "../recipes/types.ts";
import type { Env } from "./credentials.ts";
import { Secret } from "./secret.ts";
import { state } from "./state.ts";
import { outputs } from "./terraform.ts";
import { openVault, type VaultName } from "./vault.ts";

/**
 * Copies every resource's Terraform outputs into the vault (all of them, so `run` can inject them)
 * and keeps the non-sensitive ones in state for display. Returns counts only, never values.
 */
export async function sync(root: string, project: string, vaultName: VaultName, env: Env): Promise<{ resources: number; secrets: number; values: number }> {
  const out = await outputs(root, env);
  const vault = await openVault(project, vaultName);
  const s = await state.load(root);
  let secrets = 0;
  let values = 0;
  const tf = s.resources.filter((r) => r.strategy === "terraform");
  for (const res of tf) {
    let found = 0;
    for (const [key, spec] of Object.entries(terraformRecipe(res.recipe).outputs)) {
      const o = out[outputName(res.name, key)];
      if (!o) continue;
      found++;
      const envKey = `${envPrefix(res.name)}_${spec.env}`;
      if (o.value instanceof Secret) {
        await vault.put(envKey, o.value);
        secrets++;
      } else {
        await vault.put(envKey, Secret.of(o.value));
        res.outputs[key] = o.value;
        values++;
      }
    }
    res.applied = found > 0;
  }
  for (const res of tf) await state.upsert(root, res);
  return { resources: tf.filter((r) => r.applied).length, secrets, values };
}
