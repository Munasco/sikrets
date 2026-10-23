import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const configDir = () => process.env.SIKRETS_CONFIG_DIR || path.join(os.homedir(), ".sikrets");

// Passwords live in the OS keychain (Keychain on macOS, libsecret on Linux, Credential Manager
// on Windows) via Bun.secrets. They are never written to disk by Sikrets.
const SERVICE = "dev.sikrets";

export const keychain = {
  set: (provider: string, account: string, value: string) => Bun.secrets.set({ service: `${SERVICE}.${provider}`, name: account, value }),
  get: (provider: string, account: string) => Bun.secrets.get({ service: `${SERVICE}.${provider}`, name: account }),
  delete: (provider: string, account: string) => Bun.secrets.delete({ service: `${SERVICE}.${provider}`, name: account }),
};

// Non-secret record of which providers are connected and how.
export interface Connection {
  provider: string;
  account: string;
  mode: "watch" | "terminal";
  connectedAt: string;
}

const connectionsFile = () => path.join(configDir(), "connections.json");

export async function listConnections(): Promise<Connection[]> {
  try {
    return JSON.parse(await readFile(connectionsFile(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveConnection(connection: Connection) {
  const all = (await listConnections()).filter((c) => c.provider !== connection.provider);
  all.push(connection);
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(connectionsFile(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  await chmod(connectionsFile(), 0o600);
}
