import { readFileSync, writeFileSync } from "node:fs";
import { MCP } from "./constants.ts";
import type { McpServers } from "./capabilities.ts";
import type { Server } from "./opencode.ts";
import type { Owner } from "./pool.ts";

// Each login's MCP switches. The gateway keeps them per owner and tells the owner's instance which
// servers it may use (over the plugin's RPC, which only the gateway can call), when the instance
// starts and on every change. Stock opencode clients toggle with the same connect/disconnect
// calls; the proxy answers those here.

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
}

/** Tells the owner's instance which servers it may use. */
export async function sync(oc: Server, switches: McpSwitches, owner: Owner) {
  if (!Object.keys(oc.capabilities.mcp).length) return;
  await oc
    .fetch(`/api/rpc/${encodeURIComponent(MCP.rpc.id)}/${encodeURIComponent(MCP.rpc.method)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { off: switches.off(owner) } }) })
    .catch(() => {});
}
