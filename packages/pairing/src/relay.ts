import { RELAY_API_PREFIX } from "./constants.ts";

// A fetch-only client for the relay mailbox, shared by the CLI and the app. It moves opaque blobs
// and knows nothing about what is inside them.

export interface RelayMessage {
  id: string;
  blob: string;
  expiresAt: string;
}

export function relayClient(base: string, fetcher: typeof fetch = fetch) {
  const url = (box: string, id?: string) => `${base.replace(/\/+$/, "")}${RELAY_API_PREFIX}/${box}/messages${id ? `/${id}` : ""}`;
  const check = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`Relay ${what} failed (${res.status})`);
    return res;
  };
  return {
    async put(box: string, id: string, blob: string, ttlSeconds?: number) {
      await check(await fetcher(url(box, id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ blob, ttl: ttlSeconds }) }), "put");
    },
    async list(box: string): Promise<RelayMessage[]> {
      const res = await check(await fetcher(url(box)), "get");
      return ((await res.json()) as { messages: RelayMessage[] }).messages;
    },
    async remove(box: string, id: string) {
      await check(await fetcher(url(box, id), { method: "DELETE" }), "delete");
    },
  };
}

export type RelayClient = ReturnType<typeof relayClient>;
