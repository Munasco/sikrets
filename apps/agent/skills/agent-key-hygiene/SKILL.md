---
name: Agent key hygiene
description: Move the API keys an AI agent or MCP setup uses out of .env files, shell profiles and config files into Sikrets, and give the agent time-limited access instead. Use when someone wants to harden how their agents get credentials, before anything has leaked.
---
# Agent key hygiene

Goal: no long-lived key sits where an agent (or anything it runs) can read it. Agents get a time-limited session through Sikrets; the real key stays in the keychain or vault and is attached only for that service's API hosts.

## Steps

1. **Inventory.** Ask the user to paste (keys and all; they're hidden from you) the places agents read credentials from:
   - `.env`, `.env.local` and similar files in their projects;
   - shell profiles (`~/.zshrc`, `~/.bashrc`) with `export …_KEY=`;
   - agent and MCP configs: `.mcp.json`, `claude_desktop_config.json`, `.cursor/mcp.json`, `opencode.json`, with keys in `env` or `headers`.
   Run `scan_text` on what they paste. List each key by service and redacted form.
2. **Store each key in Sikrets.** One line per service: `sikrets add <service>` (it prompts for the key, hidden) or `sikrets proxy add <service>` for services the local credential proxy fronts.
3. **Change how agents start.** Replace the raw env var with a session: `sikrets session run <service,service> --for 1h -- <agent command>`. For MCP servers that take a key, run them through Sikrets (`sikrets mcp`) instead of embedding the key in their config.
4. **Remove the old copies.** Delete the lines from `.env` files and profiles, add `.env*` to `.gitignore`, and check `git log -p` for any that were ever committed. A key that was committed or pasted somewhere shared is leaked: rotate it (`how_to_rotate <service>`) before storing the new one.
5. **Keep it that way.** Every agent run now leaves a log of the requests it made. When a stored key needs replacing, `sikrets rotate` swaps it in place; stand-ins stay the same, so nothing else changes.

## Answer shape

A short table, one row per key: service, where it was, the `sikrets` command that replaces it. Then the agent's new start command. Flag any key that needs rotating first.
