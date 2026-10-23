import { awsEnv } from "../providers/aws.ts";
import { keychain, listConnections } from "../store.ts";
import { Secret } from "./secret.ts";

export type Env = Record<string, string | Secret>;

/** Credentials Terraform needs to manage resources at each provider. Admin-level: only `apply` and `run --providers` see them. */
const builders: Record<string, () => Promise<Env>> = {
  aws: awsEnv,
  async upstash() {
    if (Bun.env.UPSTASH_EMAIL && Bun.env.UPSTASH_API_KEY) return { UPSTASH_EMAIL: Bun.env.UPSTASH_EMAIL, UPSTASH_API_KEY: Secret.of(Bun.env.UPSTASH_API_KEY) };
    const conn = (await listConnections()).find((c) => c.provider === "upstash");
    const key = conn && (await keychain.get("upstash", `${conn.account}#api-key`));
    if (!conn || !key) throw new Error("Upstash isn't connected. Run: sikrets connect upstash");
    return { UPSTASH_EMAIL: conn.account, UPSTASH_API_KEY: Secret.of(key) };
  },
};

export async function providerEnv(providers: Iterable<string>): Promise<Env> {
  const env: Env = {};
  for (const id of new Set(providers)) {
    const build = builders[id];
    if (!build) throw new Error(`Sikrets doesn't know how to authenticate Terraform to "${id}" yet`);
    Object.assign(env, await build());
  }
  return env;
}

/** Unwraps secrets at the last moment, for a child process environment only. */
export const toProcessEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : v.reveal()]));
