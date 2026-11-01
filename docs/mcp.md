# Connect Sikrets to your AI apps (MCP)

Sikrets is an MCP server. Agents can list secret names, run commands with your secrets injected, read the activity log, and sign in to websites. **No tool ever returns a secret value.** Command output is scrubbed, including base64 and URL-encoded forms.

There are two ways to connect:

- **Local (stdio).** The app starts `sikrets mcp` on your machine. Nothing listens on the network. Use this whenever the app supports it.
- **Remote (Streamable HTTP).** Run `sikrets mcp --http`, and the app connects to a URL. Each app is a named client with its own token, or with an OAuth grant that you approved.

`sikrets mcp config <app>` prints the exact snippet for an app. `sikrets mcp install <app>` writes it for you, after asking. Snippets never contain a token.

Apps: `claude-code`, `claude-desktop`, `cursor`, `vscode`, `gemini-cli`, `antigravity`, `codex`, `grok-build`, `zed`, `windsurf`, `chatgpt`, `claude`, `grok`, `gemini`.

---

## Local apps (stdio)

Use absolute paths. Desktop apps start with a bare `PATH` and no project folder, which is why the snippets pass `--root`. Restart the app after you change its config.

### Claude Code

```sh
sikrets mcp install claude-code      # writes .mcp.json in this project
# or
claude mcp add sikrets -- sikrets mcp
```

```json
{ "mcpServers": { "sikrets": { "command": "/usr/local/bin/sikrets", "args": ["mcp"] } } }
```

### Claude Desktop

```sh
sikrets mcp install claude-desktop
```

The config is in Settings → Developer → Edit Config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{ "mcpServers": { "sikrets": { "command": "/usr/local/bin/sikrets", "args": ["mcp", "--root", "/path/to/project"] } } }
```

### Cursor

```sh
sikrets mcp install cursor           # ~/.cursor/mcp.json
```

The JSON has the same shape as Claude Desktop's. For one project only, put it in `.cursor/mcp.json`.

### VS Code (GitHub Copilot)

```sh
sikrets mcp install vscode           # .vscode/mcp.json
```

```json
{ "servers": { "sikrets": { "type": "stdio", "command": "/usr/local/bin/sikrets", "args": ["mcp", "--root", "/path/to/project"] } } }
```

### Gemini CLI

Run `sikrets mcp install gemini-cli`. It adds `mcpServers.sikrets` (`command`, `args`, `cwd`) to `~/.gemini/settings.json`.

### Google Antigravity

Run `sikrets mcp install antigravity`. It writes to `~/.gemini/config/mcp_config.json`, using the same shape as Claude Desktop.

### OpenAI Codex CLI

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.sikrets]
command = "/usr/local/bin/sikrets"
args = ["mcp", "--root", "/path/to/project"]
```

### Grok Build (CLI)

```sh
grok mcp add sikrets -- /usr/local/bin/sikrets mcp --root /path/to/project
```

Grok Build also reads `.mcp.json` and `.cursor/mcp.json`.

### Zed, Windsurf / Devin Desktop

To get the snippet, run `sikrets mcp config zed` (it goes in `context_servers` in Zed's settings) or `sikrets mcp config windsurf`.

Windsurf is now Devin Desktop, and its config location has moved. Check `.devin/config.json` if `~/.codeium/windsurf/mcp_config.json` isn't read.

---

## Remote (Streamable HTTP)

```sh
sikrets mcp --http                   # http://127.0.0.1:7787/mcp, this machine only
sikrets mcp --http --port 9000 --allow bun --allow terraform
```

How the HTTP server is protected:

- **Auth is always on.** A request without a current token gets `401`. Each client is one agent identity: its name appears in login approvals, grants and the activity log, and the client can't claim a different name.
- **Tokens are stored safely.** Bearer tokens live in your OS keychain, and `~/.sikrets/mcp-clients.json` holds only SHA-256 hashes. `sikrets mcp clients rm <name>` revokes a client on its next request.
- **It listens on localhost by default.** The server binds to `127.0.0.1`, and it rejects any `Host` or `Origin` header that isn't this machine or your `--public-url`. This blocks DNS rebinding.
- **Requests are rate limited.** Each client gets 120 requests a minute, with bursts of 30. Bad tokens and OAuth prompts have their own limits. Request bodies are capped at 1 MB.
- **Programs must be named when exposed.** If the server can be reached from outside this machine (`--public-url` or a non-loopback `--host`), it won't start until you list the programs agents may run with `--allow`.

### Bearer-token clients (local apps over HTTP)

```sh
sikrets mcp clients add cursor       # token → keychain + clipboard (never printed)
export SIKRETS_MCP_TOKEN="$(sikrets mcp clients token cursor)"   # pipe only; refuses to print to a terminal
sikrets mcp config cursor --http
sikrets mcp clients                  # list
sikrets mcp clients rm cursor        # revoke
```

Each app reads the token in its own way:

| App | HTTP snippet |
|---|---|
| Claude Code (`.mcp.json`) | `{"type":"http","url":"http://127.0.0.1:7787/mcp","headers":{"Authorization":"Bearer ${SIKRETS_MCP_TOKEN}"}}` |
| Cursor | `{"url":"…/mcp","headers":{"Authorization":"Bearer ${env:SIKRETS_MCP_TOKEN}"}}` |
| VS Code | `"type":"http"` plus a `promptString` input with `"password": true`; the header is `Bearer ${input:sikrets-token}` |
| Gemini CLI | `{"httpUrl":"…/mcp","headers":{"Authorization":"Bearer $SIKRETS_MCP_TOKEN"}}` |
| Codex | `url = "…/mcp"` and `bearer_token_env_var = "SIKRETS_MCP_TOKEN"` |
| Grok Build | `grok mcp add --transport http sikrets <url> --header "Authorization: Bearer ${SIKRETS_MCP_TOKEN}"` |

### Cloud apps: ChatGPT, Claude.ai, Gemini app, grok.com

These apps connect from their own servers, so `127.0.0.1` means nothing to them. They need:

1. **A public https URL that forwards to your machine** (see Tunnels below).
2. **OAuth.** ChatGPT can't send a fixed token. Run the server with `--oauth`:

   ```sh
   sikrets mcp --http --oauth --public-url https://<your-tunnel-host> --allow bun
   ```

   This serves OAuth 2.1:
   - Discovery: RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata.
   - Dynamic client registration.
   - PKCE (S256) is required.
   - Access tokens last one hour. Refresh tokens are rotated and last 30 days.

   When an app connects, **your Mac shows a Sikrets dialog** naming the app and where it returns to. You approve it, then confirm with Touch ID. Nobody on the internet can approve it for you. On other operating systems the answer is always "deny".

   Approved apps show up in `sikrets mcp clients` as, for example, `chatgpt-3f2a`. Remove one with `sikrets mcp clients rm chatgpt-3f2a`.

#### ChatGPT

1. Start a tunnel. Then run `sikrets mcp --http --oauth --public-url https://<host> --allow <program>`.
2. On chatgpt.com, go to **Plugins → + → Add custom MCP server**. Set the URL to `https://<host>/mcp` and the authentication to **OAuth**. Leave the client ID and secret empty.
3. Approve the prompt on your Mac.

Plan limits: Business and Enterprise/Edu get full MCP, and admins create the server. Pro is limited to read and fetch.

Alternative: OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can run `sikrets mcp` (stdio) behind its own tunnel client. Then no HTTP port is opened on your machine.

#### Claude (claude.ai, plus Claude Desktop and mobile connectors)

1. Start a tunnel and the server, the same way as for ChatGPT.
2. On claude.ai, go to **Customize → Connectors → Add custom connector**. Set the URL to `https://<host>/mcp` and the OAuth client to **Register automatically**. On Team or Enterprise plans, an owner adds the connector under Organization settings → Connectors.
3. Approve the prompt on your Mac. The connector then also works in Claude Desktop and mobile.

If your organization has the beta **Request headers** option, you can skip OAuth. Choose "No sign-in" and add the header `authorization: Bearer <token>`, with a token from `sikrets mcp clients add claude`.

#### Gemini app

On gemini.google.com, go to **Settings → Connected Apps → Custom apps → Add a custom app** and enter `https://<host>/mcp`. It signs in with OAuth.

This is only available in the US, for personal accounts, in English. For local use, Gemini CLI or Antigravity is simpler.

#### Grok

- **grok.com:** go to **grok.com/connectors → New Connector → Custom** and enter `https://<host>/mcp`. Use OAuth, or a token from `sikrets mcp clients add grok` if it asks for an API key.
- **xAI API:** use `{"type":"mcp","server_url":"https://<host>/mcp","server_label":"sikrets","authorization":"<token>"}`.

### Tunnels

Sikrets never opens a tunnel on its own. Start one yourself, pass its URL with `--public-url`, and stop it when you're done.

```sh
# Cloudflare quick tunnel (random https://*.trycloudflare.com URL, no account)
cloudflared tunnel --url http://127.0.0.1:7787

# Tailscale Funnel (stable https://<machine>.<tailnet>.ts.net URL)
tailscale funnel 7787
```

Warnings:

- **A public URL is reachable by anyone who learns it.** Requests still need a token or an approved OAuth grant, but keep `--allow` short. With a public URL, any app you approve can run those programs with your secrets.
- Secret values never cross MCP. A program you allow could still send a value over the network itself. Allow only programs you trust.
- A quick-tunnel URL changes every time it restarts. Restart Sikrets with the new `--public-url` and update the app.
- Stop the tunnel when you're not using it. Run `sikrets mcp clients` now and then, and `rm` anything you don't recognize.

---

## Apps that can't connect yet

- **Claude Duet** works with connectors already added in Claude. Whether custom connectors work there isn't documented.
- **Grok Bot** runs in xAI's cloud. Custom MCP setup isn't officially documented.
- **Meta Muse** offers "custom connectors" without saying they use MCP. Muse Code (the CLI) does support MCP, over stdio and Streamable HTTP.
- **Duet AI** is the old name for Gemini in Google Workspace and isn't a separate app.

## Sources (checked November 2026)

- ChatGPT: <https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt>, <https://developers.openai.com/apps-sdk/build/auth>
- Claude connectors: <https://claude.com/docs/connectors/custom/add-unlisted>, <https://claude.com/docs/connectors/building/authentication>
- Claude Code: <https://code.claude.com/docs/en/mcp>
- Claude Desktop: <https://modelcontextprotocol.io/docs/develop/connect-local-servers>
- Cursor: <https://cursor.com/docs/context/mcp>
- VS Code: <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>
- Gemini CLI: <https://geminicli.com/docs/tools/mcp-server/>; Antigravity: <https://antigravity.google/docs/mcp>; Gemini app: <https://support.google.com/gemini/answer/17209137>
- Grok: <https://docs.x.ai/grok/connectors>, <https://docs.x.ai/developers/tools/remote-mcp>, <https://docs.x.ai/build/features/mcp-servers>
- Codex: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>; Zed: <https://zed.dev/docs/ai/mcp>; Devin Desktop: <https://docs.devin.ai/desktop/cascade/mcp>
