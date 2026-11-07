#!/usr/bin/env bun
import { readConfig, startServer, startupWarnings } from "./index.ts";

// `bun run start`: the server configured from the environment (see ENV in constants.ts), on
// DynamoDB by default, or SQLite for a single process. `sikrets server` in the CLI runs it locally.

try {
  const config = readConfig(process.env);
  const server = await startServer(config);
  const where = config.store.kind === "sqlite" ? `SQLite in ${config.store.dir}` : `DynamoDB table ${config.store.table} (${config.store.region})`;
  console.log(`Sikrets server on ${config.publicUrl ?? server.url} · ${where} · ${config.approval.mode} approval`);
  for (const warning of startupWarnings(config)) console.warn(warning);
  const stop = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  console.error(`sikrets-server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
