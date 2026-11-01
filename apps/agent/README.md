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

Keys in a message are swapped for placeholders like `[[secret sk_live_…cdef #52968a57]]` by the plugin's `prompt` hook, when opencode admits the message and before it stores it or emits it as an event. The real values stay in the plugin's memory, per session. The model passes placeholders to tools; the tools swap them back on the server and return only redacted findings (prefix…last4 and a SHA-256). Two more checks run on every model request: the `context` hook redacts anything that still looks like a key, and the `http.request` hook refuses to send a request that holds a known secret. What counts as a key: our 26 patterns (`src/patterns.ts`), [gitleaks](https://github.com/gitleaks/gitleaks)' 218 rules, the generic `name = value` rule, and, in chat only, any long high-entropy token. gitleaks' config is vendored with its MIT license in `vendor/gitleaks/` and compiled into `src/gitleaks.ts` by `bun run build:rules`, converting its Go regex syntax to JavaScript (none needed skipping; the conversion matches Go's results on a 150,000-line corpus). Four rules are left out: `generic-api-key` (ours covers it), `pkcs12-file` (file names only), and the two `curl` rules, which backtrack for hundreds of milliseconds on a crafted message in JavaScript. A rule runs only if one of its keywords is in the text, so a typical message takes about 15 µs and a 60 KB one under 1 ms (`bun run bench`). `src/redaction.test.ts` runs the real opencode binary against a stand-in model and checks that a pasted key never appears in the model requests, the event stream, the stored session or any file opencode writes, and that the tool still gets the real key.

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
| `GEMINI_API_KEY` | The model key (`MODEL.keyEnv`). In the enclave, `bootstrap.py` decrypts it and passes it as `MODEL_API_KEY`. |
| `ACCESS_CODE` | unset: open. Set: the page asks for it. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` |
| `OPENCODE_PORT` / `OPENCODE_HOME` | `4097` / `$TMPDIR/sikrets-opencode` |
| `GATEWAY_LOG` | `1` logs each API call's method, path and status (never queries or bodies). |

## Hosting

`deploy/aws.sh` sets up us-east-1: a Graviton instance (c7g.xlarge, IMDSv2, SSM only, no SSH) with Nitro Enclaves enabled, reachable only from CloudFront, which serves HTTPS. The instance role can read two SSM parameters (the access code and the model key's ciphertext) and send one metric; nothing else. The access code is generated once and also saved to your macOS keychain:

```sh
security find-generic-password -s sikrets-agent-demo -a access-code -w
```

| Env for `aws.sh` | |
|---|---|
| `GEMINI_API_KEY` | Store or replace the model key, encrypted under the KMS key (String `/sikrets-agent-demo/model-key-ciphertext`). |
| `ENCLAVE_PCR0` | Pin the KMS key to this enclave build. |
| `DEPLOY_REF` | Tag or commit SHA a new instance deploys. Required to create one. |
| `ALERT_EMAIL` | Subscribe an address to the alerts topic. No address is stored in the repo. |
| `BUDGET_USD` | Monthly budget, default 150. |

**Deploys are pinned.** `aws.sh` resolves `DEPLOY_REF` to a commit SHA and writes it into `user-data.sh`, which fetches exactly that commit and stops if the checkout's SHA differs. To move the running instance to another commit (over SSM, as root):

```sh
cd /opt/sikrets-agent/src && sudo -u sikrets git fetch -q --depth 1 origin <sha> && sudo -u sikrets git checkout -q --detach <sha>
test "$(sudo -u sikrets git rev-parse HEAD)" = <sha> && apps/agent/deploy/enclave/host.sh up
```

`deploy/enclave/host.sh up` (on the instance) runs the agent inside the Nitro Enclave:

- **Isolation:** the host can't read the enclave's memory. It only relays encrypted bytes: TLS to the model API (`MODEL.host`, now generativelanguage.googleapis.com), GitHub, OSV and KMS runs from inside the enclave, through vsock proxies allowed to reach just those four hosts. The gateway and opencode both run inside.
- **The model key:** stored only as KMS ciphertext. The KMS key's policy lets nobody decrypt, re-encrypt or create grants, except the instance role calling `Decrypt` with an attestation document whose PCR0 (`kms:RecipientAttestation:ImageSha384`) is the pinned build. The host hands the enclave the ciphertext and the role's temporary credentials; the enclave makes a fresh RSA key, asks the Nitro Security Module for an attestation document carrying it, and calls KMS itself. KMS returns the key encrypted to that RSA key, so the host relaying the call only ever sees ciphertext, and the same call from the host, without the enclave's attestation, is refused. Whoever controls the AWS account can still change the key policy; that's logged in CloudTrail.
- **The access code:** the host reads it from SSM and hands it over vsock with the ciphertext, every 15 minutes, so a rotated value reaches the enclave without a rebuild. The enclave answers with a status the host logs (`journalctl -u sikrets-enclave-feed`), never a secret.
- **Attestation:** `/attestation` returns a document signed by the Nitro Security Module. Its PCR0–2 must match the measurements `nitro-cli build-enclave` printed for this build.

A new build has a new PCR0, so the key won't decrypt for it until it's pinned. After `host.sh up` prints the measurements, from your machine:

```sh
ENCLAVE_PCR0=<PCR0> deploy/aws.sh
```

The enclave's feed retries every minute until then. `host.sh down` serves from the host again, without the model key: only the enclave can decrypt it.

**Operations.** Alarms and the budget notify the SNS topic `sikrets-agent-demo-alerts`:

- `sikrets-agent-demo-enclave-health`: the host's watch sends a heartbeat (`Sikrets/AgentDemo` `EnclaveHealthy`) every minute: 1 while the enclave runs and its gateway answers `/healthz`. Three minutes of 0, or of nothing, alarm.
- `sikrets-agent-demo-gateway-5xx`: more than 5% of requests through CloudFront got a 5xx, in 2 of 3 five-minute periods.
- Budget `sikrets-agent-demo`: costs tagged `Project=sikrets-agent-demo` past $150 a month, actual or forecast.

Live build (commit `d25b50c`, deployed 2026-11-01):

| PCR | Value |
|---|---|
| PCR0 | `9b8ed97223978f3cb9821bc4473a165938d98eab13f64d7e1c1c4990bf016fc0da678d4a9c4af6b794c636da9b5a4b05` |
| PCR1 | `3b4a7e1b5f13c5a1000b3ed32ef8995ee13e9876329f9bc72650b918329ef9cf4e2e4d1e1e37375dab0ba56ba0974d03` |
| PCR2 | `57be25a04b024e0615c9a4744599a894406c8bca6aab555247c0eb8480f232f1f412ce1f822d452e555d3e56c6a4f91e` |
