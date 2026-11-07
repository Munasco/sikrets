import { existsSync } from "node:fs";
import path from "node:path";
import { createGateway } from "./gateway.ts";
import { Pool } from "./pool.ts";
import { MODEL, OPENCODE, SERVER, TLS } from "./constants.ts";
import { proxyFront } from "./tls-front.ts";

// Starts the gateway (src/gateway.ts); it starts each owner's sandboxed opencode on loopback on
// their first request (src/pool.ts). Plain HTTP on SERVER.port (CloudFront's origin, and health
// checks); HTTPS too when the enclave has its certificate (TLS), behind the PROXY v2 front.

const pool = new Pool();
process.on("exit", () => pool.stop());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

const gateway = createGateway(pool, {
  accessCode: SERVER.accessCode,
  accessCodeFile: SERVER.accessCodeFile,
  healthFile: SERVER.healthFile,
  fullAccessFile: path.join(OPENCODE.home, "full-access.json"),
  mcpFile: path.join(OPENCODE.home, "mcp-switches.json"),
  revokedFile: path.join(OPENCODE.home, "revoked-logins.json"),
});

const clientOf = (req: Request, server: Bun.Server<unknown>) =>
  req.headers.get("cloudfront-viewer-address")?.replace(/:\d+$/, "") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? server.requestIP(req)?.address ?? "unknown";

const server = Bun.serve({
  port: SERVER.port,
  hostname: SERVER.host,
  idleTimeout: 255,
  fetch: (req, server) => gateway.fetch(req, clientOf(req, server)),
});

let https = "";
if (existsSync(TLS.certFile) && existsSync(TLS.keyFile)) {
  const front = proxyFront({ hostname: "127.0.0.1", port: TLS.port, target: { hostname: "127.0.0.1", port: TLS.serverPort } });
  Bun.serve({
    port: TLS.serverPort,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    tls: { cert: Bun.file(TLS.certFile), key: Bun.file(TLS.keyFile) },
    // Only the front connects here, so the client is whoever its PROXY header named. Headers a
    // client sends (x-forwarded-for) are not trusted on this path.
    fetch: (req, server) => gateway.fetch(req, front.clientOf(server.requestIP(req)?.port) ?? "unknown"),
  });
  https = `, https://${TLS.host} (TLS in here)`;
}

console.log(`Sikrets security agent on http://${server.hostname}:${server.port}${https} (${MODEL.provider}/${MODEL.id}, sandbox: ${pool.mode}${SERVER.accessCode || SERVER.accessCodeFile ? ", access code required" : ""})`);
