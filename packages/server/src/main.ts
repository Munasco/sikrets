#!/usr/bin/env bun
import { readConfig, startServer } from "./index.ts";

// `bun run start`: the server configured from the environment (see ENV in constants.ts). For one
// person on one machine, `sikrets server` in the CLI does the same with SQLite in ~/.sikrets.

try {
  const config = readConfig(process.env);
  const server = await startServer(config);
  const where = config.store.kind === "sqlite" ? `SQLite in ${config.store.dir}` : `DynamoDB table ${config.store.table} (${config.store.region})`;
  console.log(`Sikrets server on ${config.publicUrl ?? server.url} · ${where} · ${config.approval.mode} approval`);
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
