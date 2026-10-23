import path from "node:path";
import { readJson, writePrivate } from "./core/fs.ts";

export const configDir = () => Bun.env.SIKRETS_CONFIG_DIR || path.join(Bun.env.HOME ?? "", ".sikrets");

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

export const listConnections = () => readJson<Connection[]>(connectionsFile(), []);

export async function saveConnection(connection: Connection) {
  const all = (await listConnections()).filter((c) => c.provider !== connection.provider);
  all.push(connection);
  await writePrivate(connectionsFile(), JSON.stringify(all, null, 2) + "\n");
}
