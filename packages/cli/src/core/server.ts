import os from "node:os";
import { DeviceAuthError, deviceClient, normalizeServer, readSession, savedServer, writeSession, type DeviceClient, type DeviceSession } from "./device-auth.ts";
import { thisDevice } from "./device.ts";
import { ENV, SERVER } from "../constants.ts";

// Which Sikrets server this run talks to, and a signed-in connection to it. Users never have to
// name ours; a custom one comes from, in order: --server, SIKRETS_SERVER, "server" in
// sikrets.json, then the server `sikrets login --server` saved for this profile.
//
// sikrets.json is committed, so anyone with access to the repository can set its server. It must
// be https (or this machine), and it never silently wins over the server you signed in to: when
// the two differ, the command stops and asks for --server. Signing in on its own, without
// `sikrets login`, only happens for a server on this machine.

/** Set from the global --server flag by the CLI entry point. */
export const serverFlag: { value?: string } = {};

/** A server on this machine. */
export const isLoopback = (url: string) => (SERVER.loopbackHosts as readonly string[]).includes(new URL(url).hostname);

export function checkServerUrl(url: string, from: string, opts: { httpsUnlessLoopback?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${from} must be a URL like https://sikrets.example.com, not "${url}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${from} must be an http(s) URL`);
  if (opts.httpsUnlessLoopback && u.protocol !== "https:" && !isLoopback(url)) throw new Error(`${from} must be https (http only for a server on this machine), not "${url}"`);
  return normalizeServer(u.origin + u.pathname);
}

export type ServerSource = "flag" | "env" | "project" | "saved" | "default";

/** The server and where the choice came from. */
export async function chooseServer(project: { server?: string } = {}, flag: string | undefined = serverFlag.value): Promise<{ url: string; source: ServerSource }> {
  if (flag) return { url: checkServerUrl(flag, "--server"), source: "flag" };
  const env = Bun.env[ENV.server];
  if (env) return { url: checkServerUrl(env, ENV.server), source: "env" };
  const saved = await savedServer();
  if (project.server) {
    const url = checkServerUrl(project.server, `"server" in sikrets.json`, { httpsUnlessLoopback: true });
    if (saved && saved !== url) throw new Error(`This project's sikrets.json names the server ${url}, but you signed in to ${saved}. Say which to use: --server ${url} or --server ${saved}`);
    return { url, source: "project" };
  }
  return saved ? { url: saved, source: "saved" } : { url: SERVER.defaultUrl, source: "default" };
}

export const resolveServer = async (project: { server?: string } = {}, flag?: string) => (await chooseServer(project, flag ?? serverFlag.value)).url;

export interface Connection {
  server: string;
  client: DeviceClient;
  session: DeviceSession;
}

/**
 * This device, signed in to `server`. A server on this machine that approves sign-ins itself
 * (`sikrets server`) is signed in to on first use; any other needs `sikrets login` first.
 */
export async function connect(server: string): Promise<Connection> {
  const device = await thisDevice();
  const client = deviceClient({ server, device });
  let session = await readSession(server);
  if (!session) {
    const info = await client.info().catch((error) => {
      throw error instanceof DeviceAuthError ? new Error(error.message) : error;
    });
    if (info.approval !== SERVER.autoApproval || !isLoopback(server)) throw new Error(`This device isn't signed in to ${server}. Run: sikrets login${server === SERVER.defaultUrl ? "" : ` --server ${server}`}`);
    session = await client.login({ name: os.hostname(), approve: () => {} });
    // Signed in for this server only; the profile's saved server stays what `sikrets login` chose.
    await writeSession(session, { remember: false });
  }
  return { server, client, session };
}
