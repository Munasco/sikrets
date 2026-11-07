import path from "node:path";
import { readJson, updateJson } from "../fs.ts";
import { configDir } from "../../store.ts";
import { LOGINS } from "../../constants.ts";
import type { AgentIdentity } from "./identity.ts";

// Who may use which login. The first time an agent asks for a login, the person decides: allow
// once (nothing is remembered), allow for this agent (remembered here until revoked), or deny.
// A grant is bound to the login's origin and to the agent's identity id (see identity.ts), never
// to the name an agent reports; nothing is granted to "every agent". If the login is re-added
// for another origin, or the agent turns out to be a different program, the person is asked again.

export interface Grant {
  readonly login: string;
  /** The origin the person approved; the grant covers no other. */
  readonly origin: string;
  /** The agent's name when it was granted, for display and `revoke --agent`. */
  readonly agent: string;
  /** The identity the grant is bound to. */
  readonly client: string;
  readonly grantedAt: string;
}

export type Decision = "once" | "always" | "deny";

/** Asks the person. Must resolve to "deny" when nobody answers. */
export type Approver = (request: { login: string; origin: string; agent: string; program?: string }) => Promise<Decision>;

const file = () => path.join(configDir(), LOGINS.grantsFile);

/** Grants from before origins and identities were recorded can't be matched, so they're dropped. */
const valid = (g: Partial<Grant>): g is Grant => typeof g.origin === "string" && typeof g.client === "string";

export const listGrants = async () => (await readJson<Partial<Grant>[]>(file(), [])).filter(valid);

export async function addGrant(login: string, origin: string, agent: AgentIdentity) {
  await updateJson<Partial<Grant>[]>(file(), [], (all) => {
    const kept = all.filter(valid);
    if (kept.some((g) => g.login === login && g.origin === origin && g.client === agent.id)) return undefined;
    return [...kept, { login, origin, agent: agent.name, client: agent.id, grantedAt: new Date().toISOString() }];
  });
}

/** Removes grants for a login: those of agents with this name, or every agent's. Returns how many were removed. */
export function revokeGrants(login: string, agent?: string): Promise<number> {
  return removeWhere((g) => g.login === login && (agent === undefined || g.agent === agent));
}

/** Removes every grant bound to one identity, e.g. when that client is removed. */
export const revokeIdentity = (client: string) => removeWhere((g) => g.client === client);

async function removeWhere(match: (g: Grant) => boolean): Promise<number> {
  let removed = 0;
  await updateJson<Partial<Grant>[]>(file(), [], (all) => {
    const keep = all.filter((g) => valid(g) && !match(g));
    removed = all.length - keep.length;
    return removed ? keep : undefined;
  });
  return removed;
}

/**
 * True when this agent may use this login on this origin now. Asks the person only when no grant
 * exists. Without a known identity nothing is remembered: "always" counts as "once".
 */
export async function authorize(
  login: string,
  origin: string,
  agent: AgentIdentity | { name: string; id?: undefined; detail?: string },
  approve: Approver,
): Promise<{ allowed: boolean; asked: boolean }> {
  if (agent.id && (await listGrants()).some((g) => g.login === login && g.origin === origin && g.client === agent.id)) return { allowed: true, asked: false };
  const decision = await approve({ login, origin, agent: agent.name, ...(agent.detail ? { program: agent.detail } : {}) }).catch((): Decision => "deny");
  if (decision === "always" && agent.id) await addGrant(login, origin, agent as AgentIdentity);
  return { allowed: decision !== "deny", asked: true };
}
