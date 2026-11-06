import os from "node:os";
import { DeviceAuthError, deviceClient, normalizeServer, readSession, savedServer, writeSession, type DeviceClient, type DeviceSession } from "./device-auth.ts";
import { thisDevice } from "./device.ts";
import { ENV, SERVER } from "../constants.ts";

// Which Sikrets server this run talks to, and a signed-in connection to it. Users never have to
// name ours; a custom one comes from, in order: --server, SIKRETS_SERVER, "server" in
// sikrets.json, then the server `sikrets login --server` saved for this profile.

/** Set from the global --server flag by the CLI entry point. */
export const serverFlag: { value?: string } = {};

export function checkServerUrl(url: string, from: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${from} must be a URL like https://sikrets.example.com, not "${url}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${from} must be an http(s) URL`);
  return normalizeServer(u.origin + u.pathname);
}

export async function resolveServer(project: { server?: string } = {}, flag: string | undefined = serverFlag.value): Promise<string> {
  if (flag) return checkServerUrl(flag, "--server");
  const env = Bun.env[ENV.server];
  if (env) return checkServerUrl(env, ENV.server);
  if (project.server) return checkServerUrl(project.server, `"server" in sikrets.json`);
  return (await savedServer()) ?? SERVER.defaultUrl;
}

export interface Connection {
  server: string;
  client: DeviceClient;
  session: DeviceSession;
}

/**
 * This device, signed in to `server`. A server that approves sign-ins itself (`sikrets server` on
 * this Mac) is signed in to on first use; any other needs `sikrets login` first.
 */
export async function connect(server: string): Promise<Connection> {
  const device = await thisDevice();
  const client = deviceClient({ server, device });
  let session = await readSession(server);
  if (!session) {
    const info = await client.info().catch((error) => {
      throw error instanceof DeviceAuthError ? new Error(error.message) : error;
    });
    if (info.approval !== SERVER.autoApproval) throw new Error(`This device isn't signed in to ${server}. Run: sikrets login${server === SERVER.defaultUrl ? "" : ` --server ${server}`}`);
    session = await client.login({ name: os.hostname(), approve: () => {} });
    // Signed in for this server only; the profile's saved server stays what `sikrets login` chose.
    await writeSession(session, { remember: false });
  }
  return { server, client, session };
}
