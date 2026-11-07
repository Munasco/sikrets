import type { CloudId, CloudProvider } from "./types.ts";

// Self-hosted clouds Sikrets can deploy its vault and agent identities into. Each is loaded only
// when used, so commands that never touch a cloud don't pay for its SDK.

export const CLOUDS: readonly CloudId[] = ["aws"];
/** Planned, not built yet; named in errors so nobody wonders whether it's a typo. */
const PLANNED = ["gcp"];

export const isCloud = (name: string): name is CloudId => (CLOUDS as readonly string[]).includes(name);

export async function cloudProvider(id: string): Promise<CloudProvider> {
  if (id === "aws") return (await import("./aws.ts")).aws;
  if (PLANNED.includes(id)) throw new Error(`Self-hosting on ${id.toUpperCase()} isn't available yet; use --provider aws, or the hosted Sikrets service`);
  throw new Error(`Unknown cloud "${id}". Available: ${CLOUDS.join(", ")}`);
}

/** The cloud to act on: the one named, else the first with a connected stack. */
export async function activeCloud(id?: string): Promise<CloudProvider> {
  if (id) return cloudProvider(id);
  for (const c of CLOUDS) {
    const p = await cloudProvider(c);
    if (await p.connected()) return p;
  }
  throw new Error("No Sikrets stack connected. Deploy one to your cloud account: sikrets cloud connect --provider aws");
}
