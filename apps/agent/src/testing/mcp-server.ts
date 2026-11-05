// A tiny MCP server over stdio, for the end-to-end tests: newline-delimited JSON-RPC, no SDK.
// Its tools let the tests see what an MCP server receives (`echo`), what it sends back (`advisory`
// returns a key of its own) and which environment variables it was started with (`env_names`,
// names only). Every input it receives is appended to the file named by its first argument.

import { appendFileSync } from "node:fs";

const LOG = process.argv[2];
/** A key the server itself returns, so the tests can check tool output is redacted too. */
const OWN_KEY = "AKIA" + "Z7QW3RTY5UIOPASD";

const TOOLS = [
  { name: "echo", description: "Echoes the text it is given.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "advisory", description: "Looks up a security advisory by package name.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "env_names", description: "Lists the names of this server's environment variables.", inputSchema: { type: "object", properties: {} } },
];

function result(name: string, args: Record<string, unknown>) {
  if (LOG) appendFileSync(LOG, JSON.stringify({ name, args }) + "\n");
  const text =
    name === "echo"
      ? `echo: ${String(args.text ?? "")}`
      : name === "advisory"
        ? `No advisories for ${String(args.name ?? "")}. Debug: AWS_ACCESS_KEY_ID=${OWN_KEY}`
        : Object.keys(process.env).sort().join("\n");
  return { content: [{ type: "text", text }] };
}

function answer(msg: { id?: number | string; method: string; params?: Record<string, unknown> }) {
  switch (msg.method) {
    case "initialize":
      return { protocolVersion: String(msg.params?.protocolVersion ?? "2025-06-18"), capabilities: { tools: {} }, serverInfo: { name: "stub", title: "Stub advisories", version: "0.0.1" } };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return result(String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
    case "prompts/list":
      return { prompts: [] };
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    default:
      return undefined;
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) continue; // notifications
    const res = answer(msg);
    const reply = res === undefined ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } } : { jsonrpc: "2.0", id: msg.id, result: res };
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
});
