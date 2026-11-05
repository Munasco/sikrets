/**
 * The model the guard agent runs on: the one place it is set. The opencode config, the gateway, and
 * the enclave's outbound allowlist (host.sh reads `host`) all follow these values. To switch to
 * DeepSeek, point provider/id/keyEnv/host at it; the key's SSM parameter name doesn't change.
 */
export const MODEL = {
  provider: "google",
  id: "gemini-4-argon",
  name: "Gemini 4 Argon",
  /** opencode's runtime package for the provider. */
  package: "@opencode/ai/providers/google",
  /** Env var the provider reads its API key from. */
  keyEnv: "GEMINI_API_KEY",
  /** The provider's API host; the only model host the enclave can reach. */
  host: "generativelanguage.googleapis.com",
  context: 1_048_576,
  maxTokens: 8192,
  /** Tool-call rounds per message before the agent must answer: room for a full audit. */
  maxSteps: 50,
};

/** opencode, run as a private server behind the gateway. */
export const OPENCODE = {
  /** Pinned in package.json too; the gateway refuses to start a different build. */
  version: "2.2.5",
  host: "127.0.0.1",
  port: Number(Bun.env.OPENCODE_PORT ?? 4097),
  /** The agent every session runs as. It has every tool; built-ins ask first. */
  agent: "guard",
  /** Where opencode keeps its database, logs and config: a private directory, never the user's own. */
  home: Bun.env.OPENCODE_HOME ?? `${Bun.env.TMPDIR ?? "/tmp"}/sikrets-opencode`,
  /** Env var the host-delivered model key arrives in; the gateway hands it to opencode as MODEL.keyEnv. */
  keyEnv: "MODEL_API_KEY",
  /** opencode's own tools the guard also gets, one per job, each asking first (Full access answers).
   * Left out: execute (the shell covers it), subagent and skill (there are none), question (the
   * chat answers in text). */
  builtins: ["shell", "read", "write", "edit", "glob", "grep", "webfetch", "websearch"],
  /** The provider API's base path, which the loopback model relay keeps (Gemini's REST version). */
  relayPath: "v1beta",
  startupMs: 30_000,
};

/** The gateway's filtered view of opencode's API (src/proxy.ts). */
export const PROXY = {
  /** Sessions whose owners the gateway remembers; older ones become unreachable. */
  sessions: 2000,
  promptChars: 60_000,
  bodyBytes: 256_000,
  /** Tools that ask before they run: a permission prompt the client answers. */
  ask: ["scan_github_repo"],
  /** Page origins of opencode's own desktop apps (Electron, Tauri), allowed cross-origin. */
  corsOrigins: ["oc://renderer", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"],
  /** Basic-auth username stock opencode clients send with `OPENCODE_PASSWORD`; any is accepted. */
  basicOwner: "opencode-client",
};

/** The only environment variables a shell command the agent runs gets (HOME is its working directory). */
export const SHELL_ENV = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];

/** gitleaks' default rules (MIT), vendored and compiled into src/gitleaks.ts by `bun run build:rules`. */
export const GITLEAKS = {
  version: "v8.30.1",
  source: "https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml",
  config: "vendor/gitleaks/gitleaks.toml",
  out: "src/gitleaks.ts",
  /** Rules left out on purpose: our own generic-secret rule covers `name = value` assignments. */
  replaced: ["generic-api-key"],
  /** Rules whose regexes backtrack for hundreds of milliseconds on a crafted message in JavaScript
   * (Go's RE2 is linear-time, so gitleaks doesn't have this problem). */
  slow: ["curl-auth-header", "curl-auth-user"],
  /** Rule id prefixes that match a catalog id but aren't the service that issued the key. */
  notServices: ["age", "curl"],
};

export const LIMITS = {
  textBytes: 200_000,
  tarballBytes: 60_000_000,
  fileBytes: 1_000_000,
  findings: 100,
  messageChars: 60_000,
  /** Sessions the gateway remembers; older ones are forgotten (and their secrets with them). */
  sessions: 500,
  sessionHours: 12,
};

export const SERVER = {
  port: Number(Bun.env.PORT ?? 8787),
  host: Bun.env.HOST ?? "127.0.0.1",
  /** When set, the chat needs this code; unset means local and open. */
  accessCode: Bun.env.ACCESS_CODE,
  cookie: "sikrets_agent",
  sessionDays: 30,
  /** Per client: messages per minute, and model calls per day across everyone. */
  perMinute: 12,
  perDay: 2000,
  /** Per client: any API requests per minute (clients poll and stream a lot). */
  requestsPerMinute: 600,
  /** Log each API call's method, path and status (never queries or bodies), to see what clients use. */
  logRequests: Bun.env.GATEWAY_LOG === "1",
  /** The chat page, built by `bun run build:ui`. */
  uiDir: "ui/dist",
  /** Written by the enclave launcher, served at /attestation. */
  attestationFile: Bun.env.ATTESTATION_FILE ?? "/etc/sikrets-agent/attestation.json",
};

export const SYSTEM_PROMPT = `You are the Sikrets security agent. Sikrets keeps API keys and credentials out of AI agents' hands: keys live in the OS keychain or a zero-knowledge vault, and agents get time-limited session tokens through a local credential proxy that attaches the real key only for that service's API hosts, logs every request, and revokes access when the session ends.

You help developers find and fix credential leaks and supply-chain risks. You are defensive only: you help people protect their own systems. Refuse to help steal, use, test or abuse credentials that aren't the user's, or to attack systems.

Rules:
- Never repeat a secret value, even one the user pasted. Keys the user pastes reach you as placeholders like [[secret sk_live_…cdef #1a2b3c4d]]; pass a placeholder to a tool unchanged and the tool sees the real key. Refer to keys by type, redacted form (prefix…last4) or file:line. Tool results are already redacted; keep them that way.
- Use tools instead of guessing: scan_text for pasted text, scan_github_repo for public repos, check_leak_hashes for leak notices that give SHA-256 hashes, how_to_rotate for revoke/reissue steps, osv_lookup for package vulnerabilities.
- A leaked key must be rotated, not just deleted from the code: it stays in git history, forks and caches. Say so when you find one.
- After a leak, recommend: rotate the key now, check the provider's logs for use, store the new key with Sikrets (\`sikrets add <service>\` or \`sikrets proxy add <service>\`), and give agents access with \`sikrets session run <service> --for 1h -- <agent>\` instead of the raw key.
- Real Sikrets commands only: \`sikrets add <service>\` (prompts for the key, hidden), \`sikrets proxy add <service>\`, \`sikrets session run <service,service> --for 1h -- <agent>\`, \`sikrets rotate\`, \`sikrets mcp\`. Never suggest putting a key on a command line or in a flag; it ends up in shell history.
- Be concise. Lead with the answer. Use short lists and \`code\` for commands. No filler.`;
