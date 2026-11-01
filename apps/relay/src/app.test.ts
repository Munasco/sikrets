import { describe, expect, test } from "bun:test";
import { createRelay } from "./app.ts";
import { memoryStore } from "./store.ts";
import { RELAY_LIMITS } from "./constants.ts";

const BOX = "0123456789abcdef0123456789abcdef";
const base = "http://relay.test";

function relay(start = 1_800_000_000_000) {
  let now = start;
  const handle = createRelay(memoryStore(), () => now);
  const call = (method: string, path: string, body?: unknown) =>
    handle(new Request(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { call, advance: (ms: number) => (now += ms) };
}

const list = async (r: ReturnType<typeof relay>, box = BOX) => ((await (await r.call("GET", `/v1/boxes/${box}/messages`)).json()) as { messages: { id: string; blob: string }[] }).messages;

describe("relay mailbox", () => {
  test("put, get and delete a message", async () => {
    const r = relay();
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "c2VhbGVk" })).status).toBe(204);
    expect(await list(r)).toEqual([expect.objectContaining({ id: "m1", blob: "c2VhbGVk" })]);
    expect((await r.call("DELETE", `/v1/boxes/${BOX}/messages/m1`)).status).toBe(204);
    expect(await list(r)).toEqual([]);
  });

  test("put replaces a message with the same id", async () => {
    const r = relay();
    await r.call("PUT", `/v1/boxes/${BOX}/messages/snapshot`, { blob: "b25l" });
    await r.call("PUT", `/v1/boxes/${BOX}/messages/snapshot`, { blob: "dHdv" });
    expect((await list(r)).map((m) => m.blob)).toEqual(["dHdv"]);
  });

  test("boxes are separate", async () => {
    const r = relay();
    await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "eA" });
    expect(await list(r, "f".repeat(32))).toEqual([]);
  });

  test("messages expire after their ttl", async () => {
    const r = relay();
    await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "eA", ttl: 60 });
    r.advance(59_000);
    expect(await list(r)).toHaveLength(1);
    r.advance(2_000);
    expect(await list(r)).toEqual([]);
  });

  test("rejects bad ids, blobs and ttls", async () => {
    const r = relay();
    expect((await r.call("GET", "/v1/boxes/not-a-box/messages")).status).toBe(400);
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/BAD!`, { blob: "eA" })).status).toBe(400);
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "not base64!" })).status).toBe(400);
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "a".repeat(RELAY_LIMITS.maxBlobChars + 1) })).status).toBe(413);
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "eA", ttl: 10 })).status).toBe(400);
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/m1`, { blob: "eA", ttl: RELAY_LIMITS.maxTtlSeconds + 1 })).status).toBe(400);
    expect((await r.call("POST", `/v1/boxes/${BOX}/messages/m1`, { blob: "eA" })).status).toBe(405);
    expect((await r.call("GET", "/elsewhere")).status).toBe(404);
  });

  test("caps messages per box", async () => {
    const r = relay();
    for (let i = 0; i < RELAY_LIMITS.maxMessagesPerBox; i++) await r.call("PUT", `/v1/boxes/${BOX}/messages/m${i}`, { blob: "eA" });
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/extra`, { blob: "eA" })).status).toBe(429);
    expect((await r.call("PUT", `/v1/boxes/${BOX}/messages/m0`, { blob: "eQ" })).status).toBe(204);
  });

  test("health check and CORS preflight", async () => {
    const r = relay();
    expect((await r.call("GET", "/health")).status).toBe(200);
    const pre = await r.call("OPTIONS", `/v1/boxes/${BOX}/messages/m1`);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
  });
});
