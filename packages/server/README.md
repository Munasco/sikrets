# @sikrets/server

Devices, sign-in and zero-knowledge storage of sealed vault values. Clients seal values before they
send them; the server only ever stores `sk1:` envelopes.

## Storage

| Store | Use |
| --- | --- |
| **DynamoDB** (`aws`, default) | Production, any number of server instances. One table: string `pk` and `sk`, TTL on `expiresAt`. |
| SQLite (`sqlite`) | One file, one server process: `sikrets server`, tests, or a small single-instance deployment. Serving beyond 127.0.0.1 prints a warning at start. |

Anything else (Postgres, another cloud) is written by whoever needs it against the storage interface
and proven with the contract suite. See below.

## Configuration

`bun run start` reads `SIKRETS_SERVER_*` from the environment (full list: `ENV` in
`src/constants.ts`).

- `SIKRETS_SERVER_STORE`: `aws` (default) or `sqlite` (single process).
- `SIKRETS_SERVER_TABLE`, `SIKRETS_SERVER_REGION`: the DynamoDB table and region. Credentials come
  from the standard AWS chain.
- `SIKRETS_SERVER_DATA`: SQLite only, the folder for the database file.
- `SIKRETS_SERVER_HOST`, `SIKRETS_SERVER_PORT`, `SIKRETS_SERVER_APPROVAL` (`auto` is loopback
  only, `manual` otherwise), `SIKRETS_SERVER_ADMIN_TOKEN`, `SIKRETS_SERVER_PUBLIC_URL`.

## Writing a storage adapter

1. Implement `Store` (exported from `@sikrets/server`, defined in `src/store.ts`): nonces,
   sign-ins, devices, revoked keys, values, audit and meta. The doc comments are the contract.
   Every lifecycle write is one conditional operation with a single winner across server
   instances: `claimNonce`, `ensureMeta`, `approveSignIn`/`denySignIn`/`collectSignIn`,
   `touchDevice` (never on a revoked device), `revokeDevice` (never rewrites `revokedAt`),
   `createSignIn`/`createDevice` (all their items or none), `createValue` and `claimDataKey`
   (a project's data-key fingerprint, set once; the server refuses writes under any other).
2. Run the contract suite against it from a `bun test` file. Pass a function that opens a fresh,
   empty store each time:

   ```ts
   import { storeContract } from "@sikrets/server/store-contract";
   import { postgresStore } from "./postgres.ts";

   storeContract("postgres", async () => {
     const store = await postgresStore(process.env.TEST_DATABASE_URL!);
     return { store, cleanup: () => store.drop() };
   });
   ```

3. Pass it to `startServer(config, { store })`, or open it the way `openStore` in `src/index.ts`
   does.

The DynamoDB adapter (`src/dynamo.ts`) is the reference implementation.
