import { createGateway } from "./gateway.ts";
import { start } from "./opencode.ts";
import path from "node:path";
import { MODEL, OPENCODE, SERVER } from "./constants.ts";

// Starts opencode on loopback and the gateway in front of it (src/gateway.ts).

const oc = await start();
process.on("exit", () => oc.stop());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

const gateway = createGateway(oc, { accessCode: SERVER.accessCode, ownersFile: path.join(OPENCODE.home, "owners.json"), fullAccessFile: path.join(OPENCODE.home, "full-access.json"), mcpFile: path.join(OPENCODE.home, "mcp-switches.json") });

const clientOf = (req: Request, server: Bun.Server<unknown>) =>
  req.headers.get("cloudfront-viewer-address")?.replace(/:\d+$/, "") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? server.requestIP(req)?.address ?? "unknown";

const server = Bun.serve({
  port: SERVER.port,
  hostname: SERVER.host,
  idleTimeout: 255,
  fetch: (req, server) => gateway.fetch(req, clientOf(req, server)),
});

console.log(`Sikrets security agent on http://${server.hostname}:${server.port} (opencode, ${MODEL.provider}/${MODEL.id}${SERVER.accessCode ? ", access code required" : ""})`);
