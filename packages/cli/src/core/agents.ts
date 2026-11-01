import path from "node:path";
import { readJson, writeJson } from "./fs.ts";
import { AGENT_NAME, ENV, FILES, PROJECT_DIR } from "../constants.ts";

// Agent identities: one named grant per agent, saying which keys it may be handed and until when.
// .sikrets/agents.json holds names and scopes only, no secrets, so it can be committed and the
// whole team sees a revocation. Revoking one agent leaves every other agent and person untouched.
//
// `authorize` is the single check every place that hands keys to an agent calls first: `run
// --agent`, `aws session` and `github token` today, and the session proxy when it lands.

export interface Agent {
  name: string;
  /** Resource names (all their keys) or individual key names this agent may use. */
  scope: string[];
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** A key on offer, with the resource it belongs to (so a scope can grant a whole resource). */
export interface Offer {
  key: string;
  resource?: string;
}

const file = (root: string) => path.join(root, PROJECT_DIR, FILES.agents);

export const agents = {
  load: (root: string) => readJson<Agent[]>(file(root), []),
  save: (root: string, all: Agent[]) => writeJson(file(root), all),
  async find(root: string, name: string) {
    return (await agents.load(root)).find((a) => a.name === name);
  },
};

export function checkAgentName(name: string) {
  if (!AGENT_NAME.test(name)) throw new Error(`Invalid agent name "${name}": use lowercase letters, digits and dashes`);
  return name;
}

export function agentStatus(a: Agent, now = Date.now()): "active" | "revoked" | "expired" {
  if (a.revokedAt) return "revoked";
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
 * Returns the keys `name` may be handed out of those on offer. Throws if the agent is unknown,
 * revoked or expired, or may use none of them.
 */
export async function authorize(root: string, name: string, offers: readonly Offer[]): Promise<string[]> {
  const a = await agents.find(root, name);
  if (!a) throw new Error(`No agent named "${name}" in this project. Add it: sikrets agent add ${name} --key <resource>`);
  const status = agentStatus(a);
  if (status === "revoked") throw new Error(`Agent "${name}" was revoked at ${a.revokedAt}; it gets no keys`);
  if (status === "expired") throw new Error(`Agent "${name}" expired at ${a.expiresAt}; it gets no keys`);
  const allowed = offers.filter((o) => permits(a, o)).map((o) => o.key);
  if (!allowed.length) throw new Error(`Agent "${name}" may not use ${offers.map((o) => o.resource ?? o.key).filter((x, i, all) => all.indexOf(x) === i).join(", ")}. Its scope: ${a.scope.join(", ")}`);
  return allowed;
}
