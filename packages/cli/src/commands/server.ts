import path from "node:path";
import { autoApproval, startServer, type RunningServer } from "../../../server/src/index.ts";
import { configDir } from "../store.ts";
import { log } from "../ui.ts";
import { SERVER } from "../constants.ts";

// sikrets server: a Sikrets server for one person on this machine, with SQLite in ~/.sikrets.
// It listens on 127.0.0.1 only and approves sign-ins from this machine automatically, so the CLI
// signs in on first use. It still only ever stores ciphertext. Point the CLI at it with
// `sikrets login --server <url>` (or SIKRETS_SERVER, or "server" in sikrets.json).

export interface LocalOptions {
  port?: number;
  dataDir?: string;
}

export const startLocal = (opts: LocalOptions = {}): Promise<RunningServer> =>
  startServer({
    host: SERVER.localHost,
    port: opts.port ?? SERVER.localPort,
    store: { kind: "sqlite", dir: opts.dataDir ?? path.join(configDir(), SERVER.dataDir) },
    approval: autoApproval(SERVER.localUser),
  });

export async function run(_args: string[], opts: Record<string, unknown>) {
  const port = opts.port === undefined ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be a port number");
  const dataDir = typeof opts.data === "string" ? path.resolve(opts.data) : undefined;
  const server = await startLocal({ port, dataDir });
  log(opts, `Sikrets server on ${server.url}, data in ${dataDir ?? path.join(configDir(), SERVER.dataDir)}. Sign-ins from this machine are approved automatically.`);
  log(opts, `Use it: sikrets login --server ${server.url}   (Ctrl-C stops it)`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
