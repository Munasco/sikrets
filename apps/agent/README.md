# Sikrets security agent

Chat with an agent that finds leaked keys and walks you through fixing them.

- **scan_text**: finds credentials in pasted code or config.
- **scan_github_repo**: scans a public repo's latest commit.
- **check_leak_hashes**: checks leak notices that give SHA-256 hashes, without needing the keys.
- **how_to_rotate**: where to revoke and reissue a key, for 3,000+ services in the Sikrets catalog.
- **osv_lookup**: known vulnerabilities for a package.

It runs on [opencode](https://github.com/anomalyco/opencode) (MIT; `@opencode/cli`, pinned in `package.json`), as a custom harness:

- **`plugin/`** is an opencode plugin: the five tools, the skills, and the hooks that keep secrets out (below).
- **`src/opencode.ts`** runs `opencode serve` on loopback with a random password, a private home directory, no project or user config, sharing and updates off, and one agent, `guard`. The five tools run freely; opencode's built-in tools (shell, read, write, edit, glob, grep, webfetch, websearch, subagent, execute) and every MCP tool ask first (the per-login Full access switch answers for you); our skills load without asking, and no others exist. Only opencode's own namespace (tools that manage the server: sessions, worktrees, models, MCP resources) is removed: the gateway owns those, and their ids name opencode. The question tool is denied and removed: it waits on a form the chat page can't show. Long tool output is cut by the plugin and saved whole under the scratch directory (`work/.tmp/tool-output/`).
- **`src/pool.ts`** gives every owner (each browser login; all basic-auth clients share one) their own opencode, started on their first request, sandboxed by `src/sandbox.ts`, and stopped when idle (below).
- **`src/gateway.ts`** is the gateway in front of them: the chat page, the access code, rate limits, `/attestation`, and a filtered proxy for opencode's own API (`src/proxy.ts`) that sends each owner's requests to their own instance, so opencode's TUI and desktop app can connect too.
- **`ui/`** is the chat page: Vite, React and Tailwind, built to static files the gateway serves. Its layout and interaction model follow [t3code](https://github.com/pingdotgg/t3code) (MIT; ideas only, no code copied), in the Sikrets theme.
- **Model:** Gemini 4 Argon through opencode's Google provider. Provider, model and key env var are set in `MODEL` in `src/constants.ts` and nowhere else.

### Secrets you paste

Keys in a message are swapped for placeholders like `[[secret sk_live_…cdef #52968a57]]` by the plugin's `prompt` hook, when opencode admits the message and before it stores it or emits it as an event. The real values stay in the plugin's memory, per session. The model passes placeholders to tools; the tools swap them back on the server and return only redacted findings (prefix…last4 and a SHA-256). Two more checks run on every model request: the `context` hook redacts anything that still looks like a key, and the `http.request` hook refuses to send a request that holds a known secret. What counts as a key: our 26 patterns (`src/patterns.ts`), [gitleaks](https://github.com/gitleaks/gitleaks)' 218 rules, the generic `name = value` rule, and, in chat only, any long high-entropy token. gitleaks' config is vendored with its MIT license in `vendor/gitleaks/` and compiled into `src/gitleaks.ts` by `bun run build:rules`, converting its Go regex syntax to JavaScript (none needed skipping; the conversion matches Go's results on a 150,000-line corpus). Four rules are left out: `generic-api-key` (ours covers it), `pkcs12-file` (file names only), and the two `curl` rules, which backtrack for hundreds of milliseconds on a crafted message in JavaScript. A rule runs only if one of its keywords is in the text, so a typical message takes about 15 µs and a 60 KB one under 1 ms (`bun run bench`). `src/redaction.test.ts` runs the real opencode binary against a stand-in model and checks that a pasted key never appears in the model requests, the event stream, the stored session or any file opencode writes, and that the tool still gets the real key.

### What the agent says it is

The agent is Sikrets' security agent and never names what it runs on. opencode adds its own system text to every request (an `<env>` block with its paths and temp directory, and a note about its own session tools); the plugin's `context`, `generate` and `compaction` hooks rewrite it before the request leaves: the env block is rebuilt with the working directory, a scratch directory inside it (also the shell's `$TMPDIR`) and the platform, notes about opencode's own tools are dropped, and any other mention, in a system part or a tool description, is renamed (`BRAND` in `src/constants.ts`). The system prompt tells the model not to name its runtime, framework or model host. Paths are Sikrets-named too: `AGENT_HOME` (`/run/sikrets` in the enclave), and in each owner's home a `work` directory and `work/.tmp`. A test checks that no request's system prompt or tool list contains "opencode".

### One sandbox per owner

Each owner gets their own opencode process (`src/pool.ts`), with its own home under `AGENT_HOME/owners/<hash>/` (database, config, working directory), its own random server password and its own model-relay token: nothing secret is shared between instances. Instances start on the owner's first request and stop after `AGENT_IDLE_MINUTES` (30) with no request, no open event stream and no chat running; at most `AGENT_MAX_INSTANCES` (8) run at once, and past that the longest-idle one is stopped. Sessions live in the owner's home, so a stopped instance comes back with them.

On Linux each instance is confined (`src/sandbox.ts`). The agent runs inside a Nitro Enclave, which has no KVM, so microVMs such as Firecracker can't run there; Linux namespaces can:

- **bubblewrap, gateway as root** (the enclave): its own pid, mount, ipc and uts namespaces; a filesystem with only `/usr`, `/etc`, the libraries, the parts of the app it needs (not `mcp.json`) read-only, and its owner's home; `/proc` that lists only its own processes; then `setpriv` drops it to the owner's own uid (from 200000), with no capabilities and `no_new_privs`.
- **bubblewrap, not root:** the same namespaces in an unprivileged user namespace, without separate uids.
- **setpriv only:** separate uids; homes are `0700`, so files and process environments stay private, but process lists are shared.
- **macOS, or Linux with none of these:** separate processes and directories only. The gateway logs a warning at startup; never serve more than one person like this.

The opencode process also marks itself non-dumpable (the plugin calls `prctl`), so the agent's own shell, running as the same uid, can't read its server password, config or relay token from `/proc`. Instances share the gateway's network namespace, so they reach exactly what the enclave allows (loopback and the vsock-proxied hosts); each one's server and relay on loopback are behind its own secrets. `src/isolation.test.ts` checks that owner B's shell can't list or read owner A's files, sessions or process environments; where there's no sandbox it skips those checks and says why. The startup line names the mode in use (`sandbox: bwrap`).

### Skills, slash commands and MCP servers

Modelled on [t3code](https://github.com/pingdotgg/t3code)'s composer (MIT; behaviour only, no code copied), on top of opencode's own support (`src/capabilities.ts`):

- **Skills** are the folders in `skills/`, one `SKILL.md` each (YAML `name` and `description`, then the playbook): `supply-chain-audit`, `leaked-key-response`, `agent-key-hygiene`. They are the only skills: opencode's built-in ones are removed and denied. The model loads one with the `skill` tool when a task matches, or you pick one in the chat by typing `$`; the mention stays in your message as a chip and the skill goes along as an attachment. Skill text is redacted like a pasted message when it's loaded.
- **Slash commands:** type `/` at the start of a message. `/scan-repo`, `/rotate` and `/check-package` are one-line shortcuts to a single tool (`COMMANDS` in `src/constants.ts`), expanded by opencode and redacted like any message; `/new` and `/compact` run in the page. opencode's own `/init`, `/review` and `/goal` need a project checkout and are hidden.
- **MCP servers** are configured on the server only, in `mcp.json` (or `AGENT_MCP_FILE`; see `mcp.example.json`): opencode's `local` (`command`, `environment`) and `remote` (`url`, `headers`) fields, plus `description`, `enabled` (the default for each login) and `tools` (an allowlist, to keep out tools that repeat one the guard has). The **MCP** menu in the composer lists them with their status and a switch per login; opencode's own connect/disconnect calls do the same for its TUI and desktop app. A server that's off for you is gone from your chats' tools. Its tools are `<server>_<tool>`; names that would clash with a tool the guard has are refused.
- **MCP and secrets:** a local server starts through `sh` with a fresh environment (`PATH`, a few basics, its own `HOME`, and the variables its config names), never the model key's stand-in, the server password or opencode's config. MCP tools never get a pasted key: the placeholders stay placeholders, their input is redacted again on the way out and their output on the way back, before opencode stores or streams it. The config read strips the MCP section, so environment values and headers don't reach clients.

### The proxy

opencode's API also has file, shell, git and config endpoints, so the gateway passes on only what chat clients need:

- **Forwarded, to the caller's own instance:** server, agent, model, provider and config reads; sessions, messages, prompts, our slash commands, compaction, interrupts, permission replies and forms; the event stream; skill, command and MCP lists, filtered to what the gateway configured.
- **Answered by the gateway:** MCP connect/disconnect (per login, as above).
- **Answered empty, without calling opencode:** files and find, git, shells, worktrees, MCP resources, references, plugins, integrations, plugin RPC.
- **Everything else:** 404.

Every request runs in the instance's private directory, whatever location a client sends. Creating a session can't choose its agent, model, permissions or an existing id. Prompts carry text and our skills' ids only. Each caller has only its own instance, so it sees only its own sessions and events: each browser login is one caller, and all basic-auth clients share one. `scan_github_repo` asks before downloading, so clients show a permission prompt; "always allow" is saved for that owner's instance.

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
| `AGENT_HOME` | `$TMPDIR/sikrets-agent`: the gateway's state, and each owner's home under `owners/` |
| `AGENT_IDLE_MINUTES` / `AGENT_MAX_INSTANCES` | `30` / `8` |
| `AGENT_SANDBOX` | `off` runs without a sandbox on Linux too (never in production) |
| `AGENT_MCP_FILE` | `mcp.json` next to this README; missing means no MCP servers. |
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
test "$(sudo -u sikrets git rev-parse HEAD)" = <sha> && sudo -u sikrets bash -c 'cd apps/agent && ~/.bun/bin/bun install --frozen-lockfile'
apps/agent/deploy/enclave/host.sh build   # the running enclave keeps serving; prints the new PCR0
```

Then pin the new PCR0 next to the live one, switch, and pin the new one alone:

```sh
ENCLAVE_PCR0=<live PCR0>,<new PCR0> deploy/aws.sh       # from your machine: both can decrypt
apps/agent/deploy/enclave/host.sh up                     # on the instance: the new image starts
ENCLAVE_PCR0=<new PCR0> deploy/aws.sh                    # once it answers
```

`host.sh rollback` starts the previous image again (keep its PCR0 pinned until the new one is verified). The build adds a temporary swap file: building an image needs more memory than the host has beside the enclave's reservation.

`deploy/enclave/host.sh` (on the instance) runs the agent inside the Nitro Enclave:

- **Isolation:** the host can't read the enclave's memory. It only relays encrypted bytes: TLS to the model API (`MODEL.host`, now generativelanguage.googleapis.com), GitHub, OSV, KMS and Let's Encrypt runs from inside the enclave, through vsock proxies allowed to reach just those five hosts. The gateway and every owner's opencode run inside, each opencode in its own bubblewrap sandbox and uid (the image installs `bubblewrap` and `util-linux`). That changes the image, so a build with it has new PCR0–2: pin the new PCR0 (below) before it can decrypt the model key, and publish the new measurements.
- **The model key:** stored only as KMS ciphertext. The KMS key's policy lets nobody decrypt, re-encrypt or create grants, except the instance role calling `Decrypt` with an attestation document whose PCR0 (`kms:RecipientAttestation:ImageSha384`) is the pinned build. The host hands the enclave the ciphertext and the role's temporary credentials; the enclave makes a fresh RSA key, asks the Nitro Security Module for an attestation document carrying it, and calls KMS itself. KMS returns the key encrypted to that RSA key, so the host relaying the call only ever sees ciphertext, and the same call from the host, without the enclave's attestation, is refused. Whoever controls the AWS account can still change the key policy; that's logged in CloudTrail.
- **HTTPS ends inside the enclave** at `https://agent.sikrets.usetennant.com` (`TLS.host`). A network load balancer passes TCP through to the instance (443 with a PROXY v2 header naming the client, 80 for the certificate challenge); the host relays the bytes over vsock without decrypting them; inside, a small front (`src/tls-front.ts`) reads the client address and hands the TLS bytes to the gateway's own HTTPS server. The enclave makes its own TLS key and gets a Let's Encrypt certificate for the hostname baked into the image (so it's part of PCR0), answering the HTTP-01 challenge itself (`bootstrap.py`). The key leaves the enclave only encrypted under a KMS data key that `GenerateDataKey`/`Decrypt` release only to the attested PCR0; the host keeps that blob and the public certificate in `/etc/sikrets-agent/tls.json` and hands them back on restart. The certificate renews 30 days before it expires. DNS: a CNAME from the hostname to the load balancer (`aws.sh` prints both). The CloudFront URL still works, but there TLS ends at CloudFront and the origin hop is plain HTTP.
- **The access code:** the host reads it from SSM and hands it over vsock with the ciphertext, every 15 minutes, so a rotated value reaches the enclave without a rebuild. The enclave answers with a status the host logs (`journalctl -u sikrets-enclave-feed`), never a secret.
- **Attestation:** `/attestation` returns a document signed by the Nitro Security Module. Its PCR0–2 must match the measurements `nitro-cli build-enclave` printed for this build.

A new build has a new PCR0, so the key won't decrypt for it until it's pinned (above); the enclave's feed retries every minute until then. `host.sh down` serves from the host again, without the model key: only the enclave can decrypt it.

**Operations.** Alarms and the budget notify the SNS topic `sikrets-agent-demo-alerts`:

- `sikrets-agent-demo-enclave-health`: the host's watch sends a heartbeat (`Sikrets/AgentDemo` `EnclaveHealthy`) every minute: 1 while the enclave runs and its gateway answers `/healthz`. Three minutes of 0, or of nothing, alarm.
- `sikrets-agent-demo-gateway-5xx`: more than 5% of requests through CloudFront got a 5xx, in 2 of 3 five-minute periods.
- Budget `sikrets-agent-demo`: costs tagged `Project=sikrets-agent-demo` past $150 a month, actual or forecast.

Live build (commit `cad8556`, deployed 2026-11-05; the KMS key is pinned to this PCR0; sandbox `bwrap`):

| PCR | Value |
|---|---|
| PCR0 | `1f88b3ab44b439d104739a5c928cd85522797bbd07478587e2b08865b9a110ae9e7f7fe1e292e2bd2b10740925fe0f9d` |
| PCR1 | `3b4a7e1b5f13c5a1000b3ed32ef8995ee13e9876329f9bc72650b918329ef9cf4e2e4d1e1e37375dab0ba56ba0974d03` |
| PCR2 | `0be774db7c6bc1beb71c3be090cf468bdf1b56a694d4ebe0acba3f3b3ed7b9d527945424e0bce75d93817c6cd2484c07` |
