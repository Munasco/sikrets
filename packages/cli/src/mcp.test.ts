import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, scrub } from "./commands/mcp.ts";
import { readActivity } from "./core/activity.ts";
import { Secret } from "./core/secret.ts";

const KEY = "fake-test-secret-0123456789abcdef";
const env = { STRIPE_KEY: Secret.of(KEY), REGION: "eu-west-1" };

let root: string;
beforeEach(async () => (root = await mkdtemp(path.join(os.tmpdir(), "sikrets-mcp-"))));
afterEach(() => rm(root, { recursive: true, force: true }));

const server = (allow: string[] = []) => createServer({ root, allow, loadEnv: async () => env });
const call = async (s: ReturnType<typeof server>, name: string, args: Record<string, unknown> = {}) => {
  const reply = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return { text: reply.result.content[0]!.text, isError: reply.result.isError };
};

describe("sikrets mcp", () => {
  test("initialize answers with the client's protocol version and offers tools", async () => {
    const reply = (await server().handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as {
      result: { protocolVersion: string; capabilities: { tools?: unknown } };
    };
    expect(reply.result.protocolVersion).toBe("2025-06-18");
    expect(reply.result.capabilities.tools).toBeDefined();
    expect(await server().handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  test("a command uses the secret but its output never contains it", async () => {
    const script = `const k = process.env.STRIPE_KEY; console.log(k); console.log(Buffer.from(k).toString("base64")); console.error(encodeURIComponent(k)); console.log(process.env.REGION)`;
    const { text, isError } = await call(server(), "run_with_secrets", { command: [process.execPath, "-e", script] });
    expect(isError).toBe(false);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(Buffer.from(KEY).toString("base64"));
    expect(text.match(/\[secret:STRIPE_KEY\]/g)?.length).toBe(3);
    expect(text).toContain("eu-west-1"); // plain values pass through
    const [entry] = await readActivity(root);
    expect(entry!.detail).toStartWith("mcp: ");
    expect(entry!.keys).toEqual(["STRIPE_KEY", "REGION"]);
  });

  test("--allow limits programs, and cwd can't leave the project", async () => {
    const denied = await call(server(["bun"]), "run_with_secrets", { command: ["/bin/cat", "/etc/hosts"] });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("isn't allowed");
    const escaped = await call(server(), "run_with_secrets", { command: ["ls"], cwd: "../.." });
    expect(escaped.isError).toBe(true);
  });

  test("timeouts and failures come back as errors, still scrubbed", async () => {
    const slow = await call(server(), "run_with_secrets", { command: [process.execPath, "-e", "await Bun.sleep(5000)"], timeout_seconds: 1 });
    expect(slow.text).toContain("timed out");
    const failed = await call(server(), "run_with_secrets", { command: [process.execPath, "-e", "throw new Error(process.env.STRIPE_KEY)"] });
    expect(failed.isError).toBe(true);
    expect(failed.text).not.toContain(KEY);
  });

  test("scrub replaces the longest form first", () => {
    expect(scrub(`a ${KEY} b`, env)).toBe("a [secret:STRIPE_KEY] b");
  });
});
