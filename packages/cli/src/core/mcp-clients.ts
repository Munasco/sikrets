import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readJson, withFileLock, writePrivateAtomic } from "./fs.ts";
import { revokeIdentity } from "./logins/grants.ts";
import type { AgentIdentity } from "./logins/identity.ts";
import { Secret } from "./secret.ts";
import { configDir } from "../store.ts";
import { MCP_HTTP } from "../constants.ts";

// Who may talk to `sikrets mcp --http`. Each client is one agent identity: a bearer-token client
// you added with `sikrets mcp clients add`, or an app you approved through OAuth. The file holds
// names and SHA-256 hashes only; a bearer token itself lives in the keychain, and OAuth tokens
// live nowhere but in the app that received them. Removing a client revokes it on the next request.

export interface Client {
  /** The agent's name in approvals, grants and the activity log. */
  readonly name: string;
  readonly kind: "token" | "oauth";
  readonly createdAt: string;
  lastUsedAt?: string;
  tokenHash?: string;
  /** OAuth only. */
  clientId?: string;
  accessHash?: string;
  accessExpiresAt?: number;
  refreshHash?: string;
  refreshExpiresAt?: number;
}

/** An app that signed itself up through OAuth dynamic client registration. Not trusted until approved. */
export interface Registration {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: string[];
  readonly createdAt: string;
  secretHash?: string;
}

interface Registry {
  clients: Client[];
  registrations: Registration[];
}

/** Where the bearer tokens are kept; Bun.secrets by default, a map in tests. */
export interface TokenVault {
  set(name: string, token: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

export const keychainTokens: TokenVault = {
  set: (name, value) => Bun.secrets.set({ service: MCP_HTTP.keychainService, name, value }),
  get: (name) => Bun.secrets.get({ service: MCP_HTTP.keychainService, name }),
  delete: async (name) => void (await Bun.secrets.delete({ service: MCP_HTTP.keychainService, name })),
};

export const newToken = (prefix: string) => Secret.of(prefix + randomBytes(MCP_HTTP.tokenBytes).toString("base64url"));
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Constant-time match of a presented token against a stored hash. */
export function matches(token: string, hash: string | undefined): boolean {
  if (!hash) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkClientName(name: string) {
  if (!MCP_HTTP.clientName.test(name)) throw new Error(`"${name}" isn't a valid client name: use lowercase letters, digits, dots, dashes or underscores (up to 48)`);
  return name;
}

/**
 * A readable agent name from an app's self-chosen name, e.g. "ChatGPT" → "chatgpt-3f2a9c01b7d4".
 * The suffix is long enough that an app can't re-register its way into another client's name.
 */
export function agentNameFor(clientName: string, clientId: string) {
  const slug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "oauth-app";
  return `${slug}-${hashToken(clientId).slice(0, MCP_HTTP.oauth.nameHashChars)}`;
}

/**
 * The identity login grants are bound to. It includes when the client was created, so a client
 * removed and added again under the same name starts with no grants.
 */
export const clientIdentity = (c: Pick<Client, "name" | "createdAt">): AgentIdentity => ({ name: c.name, id: `mcp-client:${c.name}:${c.createdAt}` });

/** An OAuth client whose refresh token has expired can never be used again. */
export const isDead = (c: Client, now: number) => c.kind === "oauth" && (c.refreshExpiresAt ?? 0) <= now && (c.accessExpiresAt ?? 0) <= now;

export function clientStore(opts: { dir?: string; tokens?: TokenVault } = {}) {
  const file = () => path.join(opts.dir ?? configDir(), MCP_HTTP.clientsFile);
  const tokens = opts.tokens ?? keychainTokens;
  const load = async (): Promise<Registry> => {
    const r = await readJson<Partial<Registry>>(file(), {});
    return { clients: r.clients ?? [], registrations: r.registrations ?? [] };
  };
  // Every write holds the file's lock (shared with other sikrets processes, e.g. `clients rm`)
  // from the read to the atomic rename, so no writer puts back what another removed. Dead OAuth
  // clients are dropped on the way.
  let queue: Promise<unknown> = Promise.resolve();
  const update = <T>(fn: (r: Registry) => T | Promise<T>): Promise<T> => {
    const next = queue.then(() =>
      withFileLock(file(), async () => {
        const r = await load();
        const out = await fn(r);
        const t = Date.now();
        r.clients = r.clients.filter((c) => !isDead(c, t));
        await writePrivateAtomic(file(), JSON.stringify(r, null, 2) + "\n");
        return out;
      }),
    );
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    load,
    update,
    list: async () => (await load()).clients,

    /** Adds a bearer-token client. The token goes to the keychain; the caller gets it once, wrapped. */
    async add(name: string): Promise<Secret> {
      checkClientName(name);
      const token = newToken(MCP_HTTP.tokenPrefix.bearer);
      let stored = false;
      try {
        await update(async (r) => {
          if (r.clients.some((c) => c.name === name)) throw new Error(`A client named "${name}" already exists. Remove it first: sikrets mcp clients rm ${name}`);
          await tokens.set(name, token.reveal());
          stored = true;
          r.clients.push({ name, kind: "token", createdAt: new Date().toISOString(), tokenHash: hashToken(token.reveal()) });
        });
      } catch (error) {
        // The registry wasn't saved: don't leave a token in the keychain that no client owns.
        if (stored) await tokens.delete(name).catch(() => undefined);
        throw error;
      }
      return token;
    },

    async token(name: string): Promise<Secret | undefined> {
      const client = (await load()).clients.find((c) => c.name === name);
      if (!client || client.kind !== "token") return undefined;
      const value = await tokens.get(name);
      return value && matches(value, client.tokenHash) ? Secret.of(value) : undefined;
    },

    /** Revokes a client, forgets its OAuth registration, and takes back its login grants. True when there was one. */
    async remove(name: string): Promise<boolean> {
      const removed = await update((r) => {
        const client = r.clients.find((c) => c.name === name);
        if (!client) return undefined;
        r.clients = r.clients.filter((c) => c !== client);
        if (client.clientId) r.registrations = r.registrations.filter((g) => g.clientId !== client.clientId);
        return client;
      });
      if (!removed) return false;
      if (removed.kind === "token") await tokens.delete(name).catch(() => undefined);
      await revokeIdentity(clientIdentity(removed).id);
      return true;
    },

    /** The client a bearer token belongs to, if it is current. Reads the file every time, so a removal takes effect at once. */
    async authenticate(token: string, now = Date.now()): Promise<Client | undefined> {
      const { clients } = await load();
      // Check every entry so the time taken doesn't say which one matched.
      let found: Client | undefined;
      for (const c of clients) {
        const hit = c.kind === "token" ? matches(token, c.tokenHash) : matches(token, c.accessHash) && (c.accessExpiresAt ?? 0) > now;
        if (hit && !found) found = c;
      }
      return found;
    },

    touch: (name: string) =>
      update((r) => {
        const c = r.clients.find((x) => x.name === name);
        if (c) c.lastUsedAt = new Date().toISOString();
      }),
  };
}

export type ClientStore = ReturnType<typeof clientStore>;
