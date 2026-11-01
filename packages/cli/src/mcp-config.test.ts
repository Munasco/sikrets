import { describe, expect, test } from "bun:test";
import { APPS, merge, snippet, type AppId } from "./commands/mcp-config.ts";

const base = { command: ["/usr/local/bin/sikrets"], root: "/Users/me/app", platform: "darwin" as const };
const LOCAL = "http://127.0.0.1:7787/mcp";
const PUBLIC = "https://name.trycloudflare.com/mcp";
const TOKEN_SHAPE = /sik_(mcp|at|rt|cs)_[A-Za-z0-9_-]{20,}/;

describe("sikrets mcp config", () => {
  test("no snippet, stdio or HTTP, ever contains a token", () => {
    for (const app of Object.keys(APPS) as AppId[])
      for (const url of [undefined, LOCAL, PUBLIC]) {
        const s = snippet({ ...base, app, url });
        expect(s.text).not.toMatch(TOKEN_SHAPE);
        expect(s.text.length).toBeGreaterThan(0);
      }
  });

  test("Claude Desktop: stdio with an absolute command and the project root", () => {
    const s = snippet({ ...base, app: "claude-desktop" });
    expect(s.file).toBe("~/Library/Application Support/Claude/claude_desktop_config.json");
    expect(s.value).toEqual({ mcpServers: { sikrets: { command: "/usr/local/bin/sikrets", args: ["mcp", "--root", "/Users/me/app"] } } });
    expect(snippet({ ...base, app: "claude-desktop", platform: "win32" }).file).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
  });

  test("Claude Code: project .mcp.json, stdio or HTTP with the token from the environment", () => {
    expect(snippet({ ...base, app: "claude-code" }).value).toEqual({ mcpServers: { sikrets: { command: "/usr/local/bin/sikrets", args: ["mcp"] } } });
    expect(snippet({ ...base, app: "claude-code", url: LOCAL }).value).toEqual({
      mcpServers: { sikrets: { type: "http", url: LOCAL, headers: { Authorization: "Bearer ${SIKRETS_MCP_TOKEN}" } } },
    });
  });

  test("Cursor, VS Code, Gemini CLI and Codex use each app's own syntax for the token", () => {
    expect(snippet({ ...base, app: "cursor", url: LOCAL }).value).toEqual({ mcpServers: { sikrets: { url: LOCAL, headers: { Authorization: "Bearer ${env:SIKRETS_MCP_TOKEN}" } } } });
    const vscode = snippet({ ...base, app: "vscode", url: LOCAL }).value as { inputs: { password: boolean }[]; servers: { sikrets: { headers: Record<string, string> } } };
    expect(vscode.inputs[0]!.password).toBe(true);
    expect(vscode.servers.sikrets.headers.Authorization).toBe("Bearer ${input:sikrets-token}");
    expect(snippet({ ...base, app: "gemini-cli", url: LOCAL }).value).toEqual({ mcpServers: { sikrets: { httpUrl: LOCAL, headers: { Authorization: "Bearer $SIKRETS_MCP_TOKEN" } } } });
    expect(snippet({ ...base, app: "codex", url: LOCAL }).text).toBe(`[mcp_servers.sikrets]\nurl = "${LOCAL}"\nbearer_token_env_var = "SIKRETS_MCP_TOKEN"`);
    expect(snippet({ ...base, app: "codex" }).text).toBe(`[mcp_servers.sikrets]\ncommand = "/usr/local/bin/sikrets"\nargs = ["mcp", "--root", "/Users/me/app"]`);
  });

  test("cloud apps get OAuth steps with the public URL, or a placeholder and a tunnel warning", () => {
    for (const app of ["chatgpt", "claude", "gemini", "grok"] as const) {
      expect(snippet({ ...base, app, url: PUBLIC }).text).toContain(PUBLIC);
      expect(snippet({ ...base, app }).text).toContain("https://<your-tunnel-host>/mcp");
      expect(snippet({ ...base, app, url: LOCAL }).text).toContain("needs an https URL");
    }
    expect(snippet({ ...base, app: "chatgpt", url: PUBLIC }).text).toContain("OAuth");
  });

  test("merge adds the server and keeps everything else", () => {
    const existing = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" }, sikrets: { command: "old" } } });
    const out = JSON.parse(merge(existing, { mcpServers: { sikrets: { command: "new", args: ["mcp"] } } }));
    expect(out).toEqual({ theme: "dark", mcpServers: { other: { command: "x" }, sikrets: { command: "new", args: ["mcp"] } } });
    expect(JSON.parse(merge(undefined, { servers: { sikrets: { type: "stdio" } } }))).toEqual({ servers: { sikrets: { type: "stdio" } } });
    expect(() => merge("{ // comment\n}", { mcpServers: {} })).toThrow("isn't plain JSON");
  });
});
