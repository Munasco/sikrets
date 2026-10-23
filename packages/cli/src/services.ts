import type { Change, Context } from "./core/plan.ts";
import type { Resource } from "./core/state.ts";

// provider/service → how to plan an add and how to read its cost. Loaded lazily per service.
export interface Service {
  plan: (input: Record<string, string | undefined>, ctx: Context) => Promise<Change[]>;
  cost: (resource: Resource) => Promise<number>;
}

export const services: Record<string, () => Promise<Service>> = {
  "upstash/redis": async () => {
    const m = await import("./providers/upstash/redis.ts");
    return {
      plan: (i, ctx) =>
        m.planRedis({ name: i.name ?? "cache", region: i.region ?? "us-east-1", plan: i.plan ?? "free", budget: i.budget ? Number(i.budget) : undefined }, ctx),
      cost: m.redisCost,
    };
  },
};

export async function service(id: string) {
  const load = services[id];
  if (!load) throw new Error(`Unknown service "${id}". Available: ${Object.keys(services).join(", ")}`);
  return load();
}
