import type { Env } from "../core/credentials.ts";
import { Secret } from "../core/secret.ts";
import { defineApiRecipe } from "./types.ts";
import { PROVIDER_URLS, USER_AGENT } from "../constants.ts";

// Upstash Developer API (https://api.upstash.com/v2, basic auth email:apiKey). The API key is minted
// once in the console by `sikrets connect upstash`; everything here is plain API calls.

const API = PROVIDER_URLS.upstash.api;

function auth(env: Env): string {
  const email = env.UPSTASH_EMAIL;
  const key = env.UPSTASH_API_KEY;
  if (typeof email !== "string" || !(key instanceof Secret)) throw new Error("Upstash isn't connected. Run: sikrets connect upstash");
  return `Basic ${btoa(`${email}:${key.reveal()}`)}`;
}

async function call<T>(env: Env, method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: auth(env), "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  // Error bodies are short provider messages; they never echo our credentials.
  if (!res.ok) throw new Error(`Upstash ${method} ${route.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface Database {
  database_id: string;
  database_name: string;
  endpoint: string;
  rest_token?: string;
}

const REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1", "ap-northeast-1", "sa-east-1"] as const;

export const redis = defineApiRecipe({
  id: "upstash/redis",
  provider: "upstash",
  summary: "A serverless Upstash Redis database (TLS), used over its REST API",
  inputs: {
    region: { kind: "choice", description: "Primary region", choices: REGIONS, default: "us-east-1" },
    plan: { kind: "choice", description: "Billing plan", choices: ["free", "payg"], default: "free" },
    budget: { kind: "number", description: "Monthly spend cap in USD (pay-as-you-go only)", default: 0, min: 0, max: 10_000 },
  },
  requires: [],
  outputs: {
    rest_url: { description: "REST endpoint", env: "REDIS_REST_URL", sensitive: false },
    rest_token: { description: "REST token", env: "REDIS_REST_TOKEN", sensitive: true },
  },
  estimate: (i) => (i.plan === "free" ? "free tier" : `pay as you go${i.budget ? `, capped at $${i.budget}/mo` : ", no cap"}`),

  async create(env, name, i) {
    const existing = await call<Database[]>(env, "GET", "/redis/databases?credentials=hide");
    if (existing.some((d) => d.database_name === name)) throw new Error(`Upstash already has a database named "${name}"`);
    const db = await call<Database>(env, "POST", "/redis/database", {
      database_name: name,
      platform: "aws",
      primary_region: i.region,
      plan: i.plan,
      ...(i.budget ? { budget: i.budget } : {}),
      tls: true,
    });
    if (!db.rest_token) throw new Error("Upstash didn't return a REST token (is credential protection on for this team?)");
    const host = db.endpoint.includes(".") ? db.endpoint : `${db.endpoint}.upstash.io`;
    return { remoteId: db.database_id, outputs: { rest_url: `https://${host}`, rest_token: Secret.of(db.rest_token) } };
  },

  destroy: (env, id) => call<void>(env, "DELETE", `/redis/database/${encodeURIComponent(id)}`),

  // Resetting the password issues a new REST token; the old one stops working immediately.
  async rotate(env, id) {
    const db = await call<Database>(env, "POST", `/redis/reset-password/${encodeURIComponent(id)}`);
    if (!db.rest_token) throw new Error("Upstash reset the password but returned no REST token");
    return { rest_token: Secret.of(db.rest_token) };
  },

  async cost(env, id) {
    const s = await call<{ total_monthly_billing?: number }>(env, "GET", `/redis/stats/${encodeURIComponent(id)}`);
    return s.total_monthly_billing ?? 0;
  },
});
