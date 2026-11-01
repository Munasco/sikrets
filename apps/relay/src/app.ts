import type { Store } from "./store.ts";
import { MAX_BODY_BYTES, RELAY_API_PREFIX, RELAY_LIMITS } from "./constants.ts";

// The relay: a mailbox of encrypted blobs. It never sees a key, a name or a decision, only box ids
// (derived from a pairing secret it doesn't have) and ciphertext. It can delay or drop messages;
// it can't read or forge them. Nothing here logs a blob.
//
//   PUT    /v1/boxes/:box/messages/:id   {blob, ttl?}  store (or replace) one message
//   GET    /v1/boxes/:box/messages                     unexpired messages in the box
//   DELETE /v1/boxes/:box/messages/:id                 remove one

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, "cache-control": "no-store", ...(body === undefined ? {} : { "content-type": "application/json" }) },
  });

const route = new RegExp(`^${RELAY_API_PREFIX}/([^/]+)/messages(?:/([^/]+))?/?$`);

export function createRelay(store: Store, clock: () => number = Date.now) {
  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return json(204);
    if (pathname === "/" || pathname === "/health") return json(200, { ok: true, service: "sikrets-relay" });
    const m = route.exec(pathname);
    if (!m) return json(404, { error: "not found" });
    const [, box, id] = m as unknown as [string, string, string | undefined];
    if (!RELAY_LIMITS.boxPattern.test(box)) return json(400, { error: "bad box id" });
    if (id !== undefined && !RELAY_LIMITS.idPattern.test(id)) return json(400, { error: "bad message id" });
    const now = Math.floor(clock() / 1000);

    try {
      if (req.method === "GET" && id === undefined) {
        const messages = (await store.list(box, now)).map((s) => ({ id: s.id, blob: s.blob, expiresAt: new Date(s.expiresAt * 1000).toISOString() }));
        return json(200, { messages });
      }
      if (req.method === "PUT" && id !== undefined) {
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) return json(413, { error: "too large" });
        let body: { blob?: unknown; ttl?: unknown };
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: "body must be JSON" });
        }
        const { blob } = body;
        if (typeof blob !== "string" || !blob || !/^[A-Za-z0-9_-]+$/.test(blob)) return json(400, { error: "blob must be base64url" });
        if (blob.length > RELAY_LIMITS.maxBlobChars) return json(413, { error: "too large" });
        const ttl = body.ttl === undefined || body.ttl === null ? RELAY_LIMITS.defaultTtlSeconds : Number(body.ttl);
        if (!Number.isInteger(ttl) || ttl < RELAY_LIMITS.minTtlSeconds || ttl > RELAY_LIMITS.maxTtlSeconds) return json(400, { error: "bad ttl" });
        const existing = await store.list(box, now);
        if (existing.length >= RELAY_LIMITS.maxMessagesPerBox && !existing.some((e) => e.id === id)) return json(429, { error: "box full" });
        await store.put(box, { id, blob, expiresAt: now + ttl });
        return json(204);
      }
      if (req.method === "DELETE" && id !== undefined) {
        await store.remove(box, id);
        return json(204);
      }
      return json(405, { error: "method not allowed" });
    } catch {
      return json(500, { error: "storage unavailable" });
    }
  };
}
