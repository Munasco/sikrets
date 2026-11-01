# Sikrets security agent

Chat with an agent that finds leaked keys and walks you through fixing them.

- **scan_text**: finds credentials in pasted code or config.
- **scan_github_repo**: scans a public repo's latest commit.
- **check_leak_hashes**: checks leak notices that give SHA-256 hashes, without needing the keys.
- **how_to_rotate**: where to revoke and reissue a key, for 3,000+ services in the Sikrets catalog.
- **osv_lookup**: known vulnerabilities for a package.

It runs on [opencode](https://github.com/anomalyco/opencode) (MIT; `@opencode/cli`, pinned in `package.json`), as a custom harness:

- **`plugin/`** is an opencode plugin: the five tools, and the hooks that keep secrets out (below).
- **`src/opencode.ts`** runs `opencode serve` on loopback with a random password, a private home directory, no project or user config, sharing and updates off, and one agent, `guard`. Every built-in tool (shell, read, edit, write, webfetch, …) is denied; only the five tools are allowed.
- **`src/gateway.ts`** is the gateway in front of it: the chat page, the access code, rate limits, `/attestation`, and a filtered proxy for opencode's own API (`src/proxy.ts`), so opencode's TUI and desktop app can connect too.
- **`ui/`** is the chat page: Vite, React and Tailwind, built to static files the gateway serves. Its layout and interaction model follow [t3code](https://github.com/pingdotgg/t3code) (MIT; ideas only, no code copied), in the Sikrets theme.
- **Model:** Gemini 4 Argon through opencode's Google provider. Provider, model and key env var are set in `MODEL` in `src/constants.ts` and nowhere else.

### Secrets you paste

Keys in a message are swapped for placeholders like `[[secret sk_live_…cdef #52968a57]]` by the plugin's `prompt` hook, when opencode admits the message and before it stores it or emits it as an event. The real values stay in the plugin's memory, per session. The model passes placeholders to tools; the tools swap them back on the server and return only redacted findings (prefix…last4 and a SHA-256). Two more checks run on every model request: the `context` hook redacts anything that still looks like a key, and the `http.request` hook refuses to send a request that holds a known secret. `src/redaction.test.ts` runs the real opencode binary against a stand-in model and checks that a pasted key never appears in the model requests, the event stream, the stored session or any file opencode writes, and that the tool still gets the real key.

### The proxy

opencode's API also has file, shell, git and config endpoints, so the gateway passes on only what chat clients need:

- **Forwarded:** server, agent, model, provider and config reads; sessions, messages, prompts, interrupts, permission replies; the event stream.
- **Answered empty, without calling opencode:** files and find, git, shells, worktrees, MCP, references, plugins, integrations, skills, commands, plugin RPC.
- **Everything else:** 404.

Every request runs in opencode's private directory, whatever location a client sends. Creating a session can't choose its agent, model, permissions or an existing id. Prompts carry text only. Each caller sees only the sessions it created, in lists and in the event stream: each browser login is one caller, and all basic-auth clients share one. `scan_github_repo` asks before downloading, so clients show a permission prompt; "always allow" is saved for the whole server.

### Clients

- **Browser:** the page at `/`, after the access code.
- **TUI:** `OPENCODE_PASSWORD=<access code> opencode --server https://dan27asb93qem.cloudfront.net` (opencode 2.x; v2 has no `attach` command).
- **Desktop app:** Settings → Server → Add server → Use password, with the URL and the access code. The app's page origins get CORS.

```sh
cd apps/agent
bun install && bun run build:ui
GEMINI_API_KEY=… bun start   # http://127.0.0.1:8787
bun test
cd ui && GATEWAY=http://127.0.0.1:8787 bun run dev   # the page with hot reload
```

| Env | Default |
|---|---|
| `GEMINI_API_KEY` | The model key (`MODEL.keyEnv`). The enclave gets it as `MODEL_API_KEY`. |
| `ACCESS_CODE` | unset: open. Set: the page asks for it. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` |
| `OPENCODE_PORT` / `OPENCODE_HOME` | `4097` / `$TMPDIR/sikrets-opencode` |
| `GATEWAY_LOG` | `1` logs each API call's method, path and status (never queries or bodies). |

## Hosting

`deploy/aws.sh` sets up us-east-1: a Graviton instance (c7g.xlarge, IMDSv2, SSM only, no SSH) with Nitro Enclaves enabled, reachable only from CloudFront, which serves HTTPS. The instance role can only read the agent's SSM parameters: the access code and the model key. Run it with `GEMINI_API_KEY` set to store or replace the key (SecureString `/sikrets-agent-demo/model-key`). The access code is generated once and also saved to your macOS keychain:

```sh
security find-generic-password -s sikrets-agent-demo -a access-code -w
```

`deploy/enclave/host.sh up` (on the instance) runs the agent inside the Nitro Enclave:

- **Isolation:** the host can't read the enclave's memory. It only relays encrypted bytes: TLS to the model API (`MODEL.host`, now generativelanguage.googleapis.com), GitHub and OSV runs from inside the enclave, through vsock proxies allowed to reach just those three hosts. The gateway and opencode both run inside.
- **Secrets:** the host reads the access code and the model key from SSM and hands them to the enclave over vsock every 15 minutes. So the host can see the model key: anyone who controls the instance could use it. Conversations and pasted keys stay inside the enclave.
- **Attestation:** `/attestation` returns a document signed by the Nitro Security Module. Its PCR0–2 must match the measurements `nitro-cli build-enclave` printed for this build.

`host.sh down` serves from the host again.
