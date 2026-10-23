import type { Env } from "../core/credentials.ts";
import type { Secret } from "../core/secret.ts";

// A recipe is everything Sikrets knows about adding one kind of thing, as typed data: the decisions
// it needs (with defaults, so no AI is needed to make them), what it depends on, what it outputs,
// and how it is provisioned. Two strategies:
//   "api"       — provisioned immediately through the provider's own API (most developer SaaS)
//   "terraform" — declared as Terraform in the project and created by `sikrets apply`
// Recipes never read config or write files; they get credentials and inputs, and return results.

export type RecipeId = `${string}/${string}`;

export type InputSpec =
  | { readonly kind: "string"; readonly description: string; readonly default: string; readonly pattern?: RegExp }
  | { readonly kind: "choice"; readonly description: string; readonly choices: readonly string[]; readonly default: string }
  | { readonly kind: "number"; readonly description: string; readonly default: number; readonly min: number; readonly max: number };

export type InputValue<S extends InputSpec> = S extends { kind: "number" } ? number : string;
export type Inputs<I extends Record<string, InputSpec>> = { readonly [K in keyof I]: InputValue<I[K]> };

export interface OutputSpec {
  readonly description: string;
  /** Environment variable suffix; the full name is <RESOURCE>_<SUFFIX>, e.g. CACHE_REDIS_REST_URL. */
  readonly env: string;
  readonly sensitive: boolean;
}

/** Another recipe this one needs; `as` is the local name the dependency is referred to by. */
export interface Requirement {
  readonly recipe: RecipeId;
  readonly as: string;
}

interface RecipeBase<I extends Record<string, InputSpec>> {
  readonly id: RecipeId;
  /** Provider whose credentials provisioning needs (see core/credentials.ts). */
  readonly provider: string;
  readonly summary: string;
  readonly inputs: I;
  readonly requires: readonly Requirement[];
  readonly outputs: Readonly<Record<string, OutputSpec>>;
  /** Rough monthly cost for dry runs. Real spend comes from `sikrets cost`. */
  estimate(inputs: Inputs<I>): string;
}

export interface Provisioned {
  /** The provider's id for what was created; how `destroy` and `cost` find it again. */
  readonly remoteId: string;
  /** Every declared output. Sensitive ones must be Secret. */
  readonly outputs: Readonly<Record<string, string | Secret>>;
}

export interface ApiRecipe<I extends Record<string, InputSpec> = Record<string, InputSpec>> extends RecipeBase<I> {
  readonly strategy: "api";
  create(env: Env, name: string, inputs: Inputs<I>): Promise<Provisioned>;
  destroy(env: Env, remoteId: string): Promise<void>;
  /** Month-to-date spend in USD, if the provider reports it per resource. */
  cost?(env: Env, remoteId: string): Promise<number>;
}

export interface TerraformRecipe<I extends Record<string, InputSpec> = Record<string, InputSpec>> extends RecipeBase<I> {
  readonly strategy: "terraform";
  /** Terraform source address of the provider, e.g. "hashicorp/aws". */
  readonly terraformProvider: string;
  /** modules/<slug>/{main,variables,outputs}.tf, shared by every resource of this recipe. */
  readonly module: { readonly main: string; readonly variables: string; readonly outputs: string };
  /** Module arguments for one resource; `dep(as, output)` references a dependency's output. */
  arguments(inputs: Inputs<I>, dep: (as: string, output: string) => string): Readonly<Record<string, string>>;
}

export type Recipe<I extends Record<string, InputSpec> = Record<string, InputSpec>> = ApiRecipe<I> | TerraformRecipe<I>;

/** Identity functions that keep each recipe's input types precise. */
export const defineApiRecipe = <I extends Record<string, InputSpec>>(r: Omit<ApiRecipe<I>, "strategy">): ApiRecipe<I> => ({ ...r, strategy: "api" });
export const defineTerraformRecipe = <I extends Record<string, InputSpec>>(r: Omit<TerraformRecipe<I>, "strategy">): TerraformRecipe<I> => ({
  ...r,
  strategy: "terraform",
});

/** Validates user-supplied strings against a recipe's inputs, filling in defaults. */
export function resolveInputs<I extends Record<string, InputSpec>>(recipe: Recipe<I>, given: Readonly<Record<string, string | undefined>>): Inputs<I> {
  const out: Record<string, string | number> = {};
  for (const [key, spec] of Object.entries(recipe.inputs) as [string, InputSpec][]) {
    const raw = given[key];
    if (raw === undefined) {
      out[key] = spec.default;
      continue;
    }
    switch (spec.kind) {
      case "string":
        if (spec.pattern && !spec.pattern.test(raw)) throw new Error(`--set ${key} must match ${spec.pattern}`);
        out[key] = raw;
        break;
      case "choice":
        if (!spec.choices.includes(raw)) throw new Error(`--set ${key} must be one of: ${spec.choices.join(", ")}`);
        out[key] = raw;
        break;
      case "number": {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw new Error(`--set ${key} must be a number from ${spec.min} to ${spec.max}`);
        out[key] = n;
        break;
      }
      default: {
        const never: never = spec;
        throw new Error(`Unhandled input kind ${JSON.stringify(never)}`);
      }
    }
  }
  return out as Inputs<I>;
}

export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const envPrefix = (name: string) => name.toUpperCase().replaceAll("-", "_");
export const moduleSlug = (id: RecipeId) => id.replace("/", "-");
export const tfIdent = (name: string) => name.replaceAll("-", "_");
