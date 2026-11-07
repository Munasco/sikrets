import { createRelay } from "./app.ts";
import { memoryStore } from "./store.ts";
import { ENV, LOCAL_PORT } from "./constants.ts";

// Local relay for development: in memory, gone when the process stops.
const port = Number(Bun.env[ENV.port] ?? LOCAL_PORT);
const server = Bun.serve({ port, hostname: "0.0.0.0", fetch: createRelay(memoryStore()) });
console.log(`Relay listening on http://localhost:${server.port}`);
