import { invoke } from "@tauri-apps/api/core";

// Everything the window knows comes from `sikrets <command> --json`, run by the Rust side in the
// chosen project folder. Outside Tauri (the browser dev server) a demo project stands in, so the
// screens can be designed and screenshotted without a vault.

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ScopeFinding {
  provider: string;
  overScoped: boolean;
  detail: string;
}

export interface KeyRow {
  key: string;
  resource: string;
  recipe: string;
  createdAt: string;
  lastRotatedAt: string | null;
  lastUsed: string | null;
  apps: string[];
  agents: string[];
  stale: boolean;
  scope: ScopeFinding | null;
  source?: string;
  ref?: string;
}

export interface Agent {
  name: string;
  scope: string[];
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  status: "active" | "revoked" | "expired";
}

export interface Approval {
  id: string;
  resource: string;
  reason: "exposed" | "expired" | "requested";
  status: "pending" | "approved" | "denied" | "expired" | "rotated" | "failed";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  message?: string;
}

export interface Login {
  name: string;
  origin: string;
  totp: boolean;
  addedAt: string;
}

export interface Grant {
  login: string;
  agent: string;
  grantedAt: string;
}

export interface Recovery {
  setUp: boolean;
  createdAt?: string;
  split?: boolean;
  matchesThisDevice?: boolean;
  file: string;
}

export interface ImportPreview {
  dryRun?: boolean;
  source: string;
  format: string;
  keys: string[];
  replaced: string[];
}

export interface Status {
  project: string;
  server: string;
  resources: { name: string; recipe?: string; state?: string }[];
}

export interface Info {
  cliPath: string;
  project: string | null;
  initialized: boolean;
  version: string;
}

interface CliOut {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `sikrets <args> --json` and parses the last JSON line it prints. */
export async function sikrets<T>(args: string[], stdin?: string): Promise<T> {
  if (!inTauri) return (await import("./demo.ts")).demo(args) as T;
  const out = await invoke<CliOut>("cli", { args: [...args, "--json"], stdin: stdin ?? null });
  if (out.code !== 0) {
    const line = out.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `sikrets ${args[0]} failed`;
    throw new Error(line.replace(/^sikrets:\s*/, ""));
  }
  const last = out.stdout.trim().split("\n").filter(Boolean).at(-1);
  return (last ? JSON.parse(last) : undefined) as T;
}

export async function info(): Promise<Info> {
  if (!inTauri) {
    // ?empty previews a fresh install: no project, and a long bundle path.
    const empty = location.search.includes("empty");
    return { cliPath: empty ? "/Users/you/Applications/Sikrets.app/Contents/Resources/bin/sikrets-aarch64-apple-darwin" : "/Applications/Sikrets.app/Contents/MacOS/sikrets", project: empty ? null : "~/code/shop", initialized: true, version: "0.1.0" };
  }
  return invoke<Info>("info");
}

export async function chooseProject(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ directory: true, title: "Choose a project folder" });
  if (typeof path !== "string") return null;
  await invoke("set_project", { path });
  return path;
}

export async function chooseFile(): Promise<string | null> {
  if (!inTauri) return "~/Downloads/Passwords.csv";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ title: "Choose an export to import", filters: [{ name: "Exports", extensions: ["env", "csv", "json", "1pux", "txt"] }, { name: "Any file", extensions: ["*"] }] });
  return typeof path === "string" ? path : null;
}

export async function copyText(text: string) {
  if (inTauri) return (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text);
  return navigator.clipboard?.writeText(text);
}

export const openTerminal = (args: string[]) => (inTauri ? invoke("open_terminal", { args }) : Promise.resolve());
export const setPending = (count: number) => (inTauri ? invoke("set_pending", { count }) : Promise.resolve());

export const agentView = {
  show: (r: { x: number; y: number; width: number; height: number }) => (inTauri ? invoke("agent_show", r) : Promise.resolve()),
  hide: () => (inTauri ? invoke("agent_hide") : Promise.resolve()),
  reload: () => (inTauri ? invoke("agent_reload") : Promise.resolve()),
};

export async function onNavigate(cb: (route: string) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("navigate", (e) => cb(e.payload));
}
