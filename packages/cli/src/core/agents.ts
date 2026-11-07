import path from "node:path";
import { readJson, writeJson } from "./fs.ts";
import { withFileLock } from "./lock.ts";
import { until } from "./ttl.ts";
import { AGENT_NAME, ENV, FILES, PROJECT_DIR } from "../constants.ts";

// Agent identities: one named grant per agent, saying which keys it may be handed and until when.
// .sikrets/agents.json holds names and scopes only, no secrets, so it can be committed and the
// whole team sees a revocation. Revoking one agent leaves every other agent and person untouched.
//
// `authorize` is the single check every place that hands keys to an agent calls first: `run
// --agent`, `aws session` and `github token` today, and the session proxy when it lands.

/** Stored lifecycle: an agent is active until revoked, and a revocation is final. */
export type AgentState = { status: "active" } | { status: "revoked"; revokedAt: string };

export type Agent = {
  /** One id per generation: re-adding an expired name appends a new generation, never edits the old one. */
  id: string;
  name: string;
  /** Resource names (all their keys) or individual key names this agent may use. */
  scope: string[];
  createdAt: string;
  expiresAt?: string;
} & AgentState;

/** What older agents.json files hold: no id, and revocation only as a timestamp. */
type StoredAgent = Omit<Agent, "id" | "status" | "revokedAt"> & { id?: string; status?: Agent["status"]; revokedAt?: string };

/** A key on offer, with the resource it belongs to (so a scope can grant a whole resource). */
export interface Offer {
  key: string;
  resource?: string;
}

const file = (root: string) => path.join(root, PROJECT_DIR, FILES.agents);

function normalize(a: StoredAgent): Agent {
  const { id, status, revokedAt, ...rest } = a;
  const base = { id: id ?? `${a.name}@${a.createdAt}`, ...rest };
  return status === "revoked" || revokedAt ? { ...base, status: "revoked", revokedAt: revokedAt ?? a.createdAt } : { ...base, status: "active" };
}

const MOVES: Record<Agent["status"], readonly Agent["status"][]> = { active: ["revoked"], revoked: [] };

/** The only way an agent's stored state changes. Throws on an illegal move (revoked is final). */
export function transition(a: Agent, to: "revoked", at = new Date().toISOString()): Agent {
  if (!MOVES[a.status].includes(to)) throw new Error(`Agent "${a.name}" is ${a.status}; it can't become ${to}`);
  return { ...a, status: "revoked", revokedAt: at };
}

/** Latest generation per name wins; older generations stay in the file as the audit trail. */
const latest = (all: readonly Agent[], name: string) => all.findLast((a) => a.name === name);

export const agents = {
  load: async (root: string) => (await readJson<StoredAgent[]>(file(root), [])).map(normalize),
  /** Replaces the whole file, under the lock. Prefer `update`, which re-reads under the lock. */
  save: (root: string, all: readonly StoredAgent[]) => withFileLock(file(root), () => writeJson(file(root), all.map(normalize))),
  /** Read-modify-write under a cross-process lock, written atomically. */
  async update<T>(root: string, fn: (all: Agent[]) => { next: Agent[]; result: T }): Promise<T> {
    return withFileLock(file(root), async () => {
      const { next, result } = fn(await agents.load(root));
      await writeJson(file(root), next);
      return result;
    });
  },
  async find(root: string, name: string) {
    return latest(await agents.load(root), name);
  },
  /**
   * Adds an agent. Refused while one by that name is active, and forever once revoked (a process
   * still holding SIKRETS_AGENT=<name> must never get access back). An expired name is renewed as
   * a new generation; the old record stays.
   */
  add(root: string, a: Pick<Agent, "name" | "scope" | "expiresAt">, now = Date.now()): Promise<Agent> {
    return agents.update(root, (all) => {
      const prev = latest(all, a.name);
      if (prev && prev.status === "revoked") throw new Error(`Agent "${a.name}" was revoked at ${prev.revokedAt}; revoked names stay revoked. Pick a new name`);
      if (prev && agentStatus(prev, now) === "active") throw new Error(`Agent "${a.name}" already exists. Revoke it and add one under a new name to change its scope`);
      const agent: Agent = { id: crypto.randomUUID(), name: a.name, scope: a.scope, createdAt: new Date(now).toISOString(), ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}), status: "active" };
      return { next: [...all, agent], result: agent };
    });
  },
  /** Revokes the latest generation of `name`. Idempotent: `already` is set when it was revoked before. */
  revoke(root: string, name: string): Promise<{ agent: Agent; already: boolean }> {
    return agents.update<{ agent: Agent; already: boolean }>(root, (all) => {
      const prev = latest(all, name);
      if (!prev) throw new Error(`No agent named "${name}"`);
      if (prev.status === "revoked") return { next: all, result: { agent: prev, already: true } };
      const revoked = transition(prev, "revoked");
      return { next: all.map((a) => (a === prev ? revoked : a)), result: { agent: revoked, already: false } };
    });
  },
};

export function checkAgentName(name: string) {
  if (!AGENT_NAME.test(name)) throw new Error(`Invalid agent name "${name}": use lowercase letters, digits and dashes`);
  return name;
}

/** Stored status, plus "expired", which time decides. */
export function agentStatus(a: Agent, now = Date.now()): "active" | "revoked" | "expired" {
  if (a.status === "revoked") return "revoked";
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return "expired";
  return "active";
}

export const permits = (a: Agent, offer: Offer) => a.scope.includes(offer.key) || (offer.resource !== undefined && a.scope.includes(offer.resource));

/** The agent a command acts for: --agent, else SIKRETS_AGENT. */
export function currentAgent(opts: Record<string, unknown>): string | undefined {
  const name = typeof opts.agent === "string" ? opts.agent : Bun.env[ENV.agent];
  return name ? checkAgentName(name) : undefined;
}

/**
 * Returns the agent and the keys it may be handed out of those on offer. Throws if the agent is
 * unknown, revoked or expired, or may use none of them.
 */
export async function authorize(root: string, name: string, offers: readonly Offer[]): Promise<{ agent: Agent; keys: string[] }> {
  const a = await agents.find(root, name);
  if (!a) throw new Error(`No agent named "${name}" in this project. Add it: sikrets agent add ${name} --key <resource>`);
  const status = agentStatus(a);
  if (a.status === "revoked") throw new Error(`Agent "${name}" was revoked at ${a.revokedAt}; it gets no keys`);
  if (status === "expired") throw new Error(`Agent "${name}" expired at ${a.expiresAt}; it gets no keys`);
  const allowed = offers.filter((o) => permits(a, o)).map((o) => o.key);
  if (!allowed.length) throw new Error(`Agent "${name}" may not use ${offers.map((o) => o.resource ?? o.key).filter((x, i, all) => all.indexOf(x) === i).join(", ")}. Its scope: ${a.scope.join(", ")}`);
  return { agent: a, keys: allowed };
}

/**
 * How long a credential handed to `a` may live: `wanted` seconds, cut to when the agent expires.
 * Throws when the agent expires before `min` seconds (the shortest credential the provider issues).
 */
export function leaseSeconds(a: Agent | undefined, wanted: number, min: number, now = Date.now()): number {
  if (!a?.expiresAt) return wanted;
  const left = Math.floor((Date.parse(a.expiresAt) - now) / 1000);
  if (left < min) throw new Error(`Agent "${a.name}" expires ${until(a.expiresAt, now)}, before the shortest credential (${Math.ceil(min / 60)}m) would; it gets none`);
  return Math.min(wanted, left);
}
