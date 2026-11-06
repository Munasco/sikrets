import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dynamoStore } from "./dynamo.ts";
import { sqliteStore } from "./sqlite.ts";
import { storeContract, type OpenStore } from "./store-contract.ts";
import { envelope } from "./testing/client.ts";
import { fakeDynamo } from "./testing/fake-dynamo.ts";
import { SQLITE } from "./constants.ts";

// The contract suite (store-contract.ts) against the adapters in this package: DynamoDB against an
// in-memory fake (with tiny pages, so pagination is exercised; no real AWS is touched), and the
// dev/test SQLite store in memory and on disk.

const adapters: [string, OpenStore][] = [
  ["sqlite (memory)", async () => ({ store: sqliteStore() })],
  [
    "sqlite (file)",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-server-store-"));
      return { store: sqliteStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
  ["dynamodb (fake)", async () => ({ store: dynamoStore(fakeDynamo({ pageSize: 2 }), "sikrets") })],
];

for (const [name, open] of adapters) storeContract(name, open);

test("sqlite on disk: owner-only file that survives reopening", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-server-store-"));
  try {
    const first = sqliteStore(dir);
    const scope = { account: "alice", project: "shop", environment: "dev" };
    const sealed = envelope();
    await first.putValue(scope, { name: "A_KEY", value: sealed, updatedAt: "t", updatedBy: "d" });
    first.close();
    expect((await stat(path.join(dir, SQLITE.file))).mode & 0o777).toBe(0o600);
    const second = sqliteStore(dir);
    expect((await second.getValue(scope, "A_KEY"))?.value).toBe(sealed);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dynamodb: values are stored as ciphertext items", async () => {
  const fake = fakeDynamo();
  const s = dynamoStore(fake, "sikrets");
  const sealed = envelope();
  await s.putValue({ account: "alice", project: "shop", environment: "dev" }, { name: "A_KEY", value: sealed, updatedAt: "t", updatedBy: "d" });
  const item = [...fake.items.values()].find((i) => i.sk?.S === "VALUE#A_KEY")!;
  expect(item.pk!.S).toBe("VAULT#alice#shop#dev");
  expect(JSON.parse(item.data!.S!).value).toBe(sealed);
});
