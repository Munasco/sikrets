import { apiKey as anthropicKey } from "./anthropic.ts";
import { ec2, vpc } from "./aws.ts";
import type { Recipe, RecipeId, TerraformRecipe } from "./types.ts";
import { redis } from "./upstash.ts";

export const recipes: ReadonlyMap<RecipeId, Recipe> = new Map<RecipeId, Recipe>([redis, anthropicKey, vpc, ec2].map((r) => [r.id, r]));

export function recipe(id: string): Recipe {
  const r = recipes.get(id as RecipeId);
  if (!r) throw new Error(`Nothing called "${id}" can be added yet. Addable: ${[...recipes.keys()].join(", ")}`);
  return r;
}

export function terraformRecipe(id: string): TerraformRecipe {
  const r = recipe(id);
  if (r.strategy !== "terraform") throw new Error(`${id} is provisioned through its API, not Terraform`);
  return r;
}
