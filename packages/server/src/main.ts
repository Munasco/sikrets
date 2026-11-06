#!/usr/bin/env bun
import { readConfig, startServer } from "./index.ts";

// `bun run start`: the server configured from the environment (see ENV in constants.ts), on
// DynamoDB by default. `sikrets server` in the CLI is the local development server (SQLite).

try {
  const config = readConfig(process.env);
  const server = await startServer(config);
  const where = config.store.kind === "sqlite" ? `SQLite in ${config.store.dir}` : `DynamoDB table ${config.store.table} (${config.store.region})`;
  console.log(`Sikrets server on ${config.publicUrl ?? server.url} · ${where} · ${config.approval.mode} approval`);
  if (config.store.kind === "sqlite") console.log("SQLite is for local development and tests only; production uses DynamoDB.");
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
