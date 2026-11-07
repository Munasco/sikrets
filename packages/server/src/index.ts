import { createApp, type AppOptions } from "./app.ts";
import type { ServerConfig } from "./config.ts";
import { sqliteStore } from "./sqlite.ts";
import type { Store } from "./store.ts";

// The server as a library: `sikrets server` and main.ts start it, tests run it in-process.

export { createApp, envelopeProblem } from "./app.ts";
export { autoApproval, manualApproval, type ApprovalPolicy } from "./approval.ts";
export { readConfig, startupWarnings, type ServerConfig } from "./config.ts";
export { sqliteStore } from "./sqlite.ts";
export { byName, type AuditEvent, type DeviceKind, type DeviceRecord, type Scope, type SignIn, type Store, type StoredValue, type ValueInfo } from "./store.ts";
// The contract suite imports bun:test, so it is its own entry: "@sikrets/server/store-contract".

export interface RunningServer {
  url: string;
  store: Store;
  stop(): void;
}

/** Opens the configured store: DynamoDB, or SQLite for local development. The AWS SDK is only loaded for the aws store. */
export async function openStore(config: ServerConfig["store"]): Promise<Store> {
  if (config.kind === "sqlite") return sqliteStore(config.dir);
  const [{ DynamoDBClient }, { dynamoStore }] = await Promise.all([import("@aws-sdk/client-dynamodb"), import("./dynamo.ts")]);
  return dynamoStore(new DynamoDBClient({ region: config.region }), config.table);
}

/** Starts listening. Pass `store` to use one already open (tests); otherwise the config's is opened. */
export async function startServer(config: ServerConfig, extra: { store?: Store; now?: AppOptions["now"] } = {}): Promise<RunningServer> {
  const store = extra.store ?? (await openStore(config.store));
  const app = createApp({ store, approval: config.approval, publicUrl: config.publicUrl, maxValueBytes: config.maxValueBytes, now: extra.now });
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return {
    url: `http://${host}:${server.port}`,
    store,
    stop() {
      server.stop(true);
      store.close();
    },
  };
}
