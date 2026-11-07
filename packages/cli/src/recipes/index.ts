import { serviceRecipe } from "../catalog/services.ts";
import { apiKey as anthropicKey } from "./anthropic.ts";
import { ec2, vpc } from "./aws.ts";
import type { Recipe, RecipeId, TerraformRecipe } from "./types.ts";
import { redis } from "./upstash.ts";

export const recipes: ReadonlyMap<RecipeId, Recipe> = new Map<RecipeId, Recipe>([redis, anthropicKey, vpc, ec2].map((r) => [r.id, r]));

/** A hand-written recipe, else the generic paste-a-key recipe for a catalog service ("stripe/api-key"). */
export function recipe(id: string): Recipe {
  const r = recipes.get(id as RecipeId) ?? serviceRecipe(id);
  if (!r) throw new Error(`Nothing called "${id}" can be added. Find it with: sikrets catalog ${id.split("/")[0]}`);
  return r;
}

export function terraformRecipe(id: string): TerraformRecipe {
  const r = recipe(id);
  if (r.strategy !== "terraform") throw new Error(`${id} is provisioned through its API, not Terraform`);
  return r;
}
