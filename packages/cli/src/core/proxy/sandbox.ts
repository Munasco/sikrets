import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The OS sandbox the agent runs in. The proxy holds real keys on the same machine, so something
// has to keep the agent from simply reading them: on macOS that is a Seatbelt profile
// (sandbox-exec) that denies the keychain, Sikrets' own files, the session's private keys and the
// usual credential files, and allows network only to localhost (the proxy, and local dev servers).
// Everything else the agent does, it can still do.

/** Credential stores an agent has no business reading during a session. */
const SECRET_PATHS = ["Library/Keychains", ".sikrets", ".aws", ".ssh", ".netrc", ".docker/config.json", ".npmrc", ".pypirc", ".git-credentials", ".config/gcloud", ".azure", ".kube"];

const quote = (p: string) => JSON.stringify(p);

/** Seatbelt matches resolved paths, and macOS temp and home folders are often behind symlinks. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // doesn't exist yet: deny the literal path
  }
}

/** gh keeps its token in the keychain, or in hosts.yml on older setups; only the latter needs hiding. */
function ghTokenFile(home: string): string[] {
  const file = path.join(home, ".config/gh/hosts.yml");
  try {
    return readFileSync(file, "utf8").includes("oauth_token") ? [file] : [];
  } catch {
    return [];
  }
}

export function seatbeltProfile(opts: { privateDirs: readonly string[]; allowKeychain?: boolean; home?: string }): string {
  const home = opts.home ?? os.homedir();
  const paths = [...ghTokenFile(home), ...SECRET_PATHS.filter((p) => !(opts.allowKeychain && p === "Library/Keychains")).map((p) => path.join(home, p)), ...opts.privateDirs].map(real);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow network-outbound (remote unix-socket))",
    ...(opts.allowKeychain ? [] : ['(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))']),
    `(deny file-read* file-write* ${paths.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
  ].join("\n");
}

/** The argv that runs `command` inside the sandbox. */
export function sandboxed(command: readonly string[], profile: string): string[] {
  if (process.platform !== "darwin") {
    throw new Error("The agent sandbox is macOS-only for now. Run with --no-sandbox to start the session without it (the agent could then read your keys directly).");
  }
  return ["/usr/bin/sandbox-exec", "-p", profile, ...command];
}
