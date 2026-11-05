import { readFileSync, writeFileSync } from "node:fs";
import { MCP } from "./constants.ts";
import type { McpServers } from "./capabilities.ts";
import type { Server } from "./opencode.ts";
import type { Owner, Owners } from "./proxy.ts";

// Each login's MCP switches. opencode's own connect/disconnect is server-wide, so the gateway keeps
// the switches per owner instead and tells the plugin which servers each of that owner's sessions
// may use (over the plugin's RPC, which only the gateway can call). Stock opencode clients toggle
// with the same connect/disconnect calls; the proxy answers those here.

export class McpSwitches {
  private choices = new Map<Owner, Record<string, boolean>>();
  constructor(
    private servers: McpServers,
    private file?: string,
  ) {
    if (!file) return;
    try {
      this.choices = new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<Owner, Record<string, boolean>>));
    } catch {}
  }
  on(owner: Owner, server: string) {
    return this.choices.get(owner)?.[server] ?? this.servers[server]?.enabled !== false;
  }
  /** The configured servers this owner has switched off (or left off). */
  off(owner: Owner) {
    return Object.keys(this.servers).filter((s) => !this.on(owner, s));
  }
  set(owner: Owner, server: string, on: boolean) {
    this.choices.set(owner, { ...this.choices.get(owner), [server]: on });
    if (this.file) writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.choices)), { mode: 0o600 });
  }
  /** Owners who changed a switch from its default. */
  owners() {
    return [...this.choices.keys()];
  }
}

/** Tells the plugin which servers a session may use. */
export async function syncSession(oc: Server, switches: McpSwitches, session: string, owner: Owner) {
  if (!Object.keys(oc.capabilities.mcp).length) return;
  await oc
    .fetch(`/api/rpc/${encodeURIComponent(MCP.rpc.id)}/${encodeURIComponent(MCP.rpc.method)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { sessionID: session, off: switches.off(owner) } }) })
    .catch(() => {});
}

/** After a restart: the plugin starts from each server's default, so re-send every changed owner's sessions. */
export async function syncAll(oc: Server, switches: McpSwitches, owners: Owners) {
  for (const owner of switches.owners()) for (const s of owners.sessionsOf(owner)) await syncSession(oc, switches, s, owner);
}
