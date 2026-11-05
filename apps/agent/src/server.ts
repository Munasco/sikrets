import { createGateway } from "./gateway.ts";
import { Pool } from "./pool.ts";
import path from "node:path";
import { MODEL, OPENCODE, SERVER } from "./constants.ts";

// Starts the gateway (src/gateway.ts); it starts each owner's sandboxed opencode on loopback on
// their first request (src/pool.ts).

const pool = new Pool();
process.on("exit", () => pool.stop());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

const gateway = createGateway(pool, { accessCode: SERVER.accessCode, fullAccessFile: path.join(OPENCODE.home, "full-access.json"), mcpFile: path.join(OPENCODE.home, "mcp-switches.json") });

const clientOf = (req: Request, server: Bun.Server<unknown>) =>
  req.headers.get("cloudfront-viewer-address")?.replace(/:\d+$/, "") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? server.requestIP(req)?.address ?? "unknown";

const server = Bun.serve({
  port: SERVER.port,
  hostname: SERVER.host,
  idleTimeout: 255,
  fetch: (req, server) => gateway.fetch(req, clientOf(req, server)),
});

console.log(`Sikrets security agent on http://${server.hostname}:${server.port} (${MODEL.provider}/${MODEL.id}, sandbox: ${pool.mode}${SERVER.accessCode ? ", access code required" : ""})`);
