import path from "node:path";
import { readJson, writePrivate } from "../fs.ts";
import { configDir } from "../../store.ts";
import { LOGINS } from "../../constants.ts";

// Who may use which login. The first time an agent asks for a login, the person decides: allow
// once (nothing is remembered), allow for this agent (remembered here until revoked), or deny.
// Grants are per agent and per login; nothing is granted to "every agent".

export interface Grant {
  readonly login: string;
  readonly agent: string;
  readonly grantedAt: string;
}

export type Decision = "once" | "always" | "deny";

/** Asks the person. Must resolve to "deny" when nobody answers. */
export type Approver = (request: { login: string; origin: string; agent: string }) => Promise<Decision>;

const file = () => path.join(configDir(), LOGINS.grantsFile);

export const listGrants = () => readJson<Grant[]>(file(), []);

const save = (all: Grant[]) => writePrivate(file(), JSON.stringify(all, null, 2) + "\n");

export async function addGrant(login: string, agent: string) {
  const all = await listGrants();
  if (!all.some((g) => g.login === login && g.agent === agent)) await save([...all, { login, agent, grantedAt: new Date().toISOString() }]);
}

/** Removes grants for a login: one agent's, or every agent's. Returns how many were removed. */
export async function revokeGrants(login: string, agent?: string): Promise<number> {
  const all = await listGrants();
  const keep = all.filter((g) => !(g.login === login && (agent === undefined || g.agent === agent)));
  if (keep.length !== all.length) await save(keep);
  return all.length - keep.length;
}

/** True when this agent may use this login now. Asks the person only when no grant exists. */
export async function authorize(login: string, origin: string, agent: string, approve: Approver): Promise<{ allowed: boolean; asked: boolean }> {
  if ((await listGrants()).some((g) => g.login === login && g.agent === agent)) return { allowed: true, asked: false };
  const decision = await approve({ login, origin, agent }).catch((): Decision => "deny");
  if (decision === "always") await addGrant(login, agent);
  return { allowed: decision !== "deny", asked: true };
}
