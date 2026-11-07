import type { Socket } from "bun";

// TLS ends inside the enclave: the load balancer passes TCP through, the host relays the bytes over
// vsock, and the gateway's own HTTPS server holds the key. The load balancer starts each connection
// with a PROXY protocol v2 header naming the client; this front reads it, remembers the client's
// address, and pipes the rest (the TLS bytes) to the HTTPS server on loopback. The gateway asks
// `clientOf` with the port its server saw, so rate limits apply per client, not per relay.

const SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
/** Bytes buffered for a connection before its header is complete, at most. */
const MAX_HEADER = 1024;

/** Parses a PROXY v2 header: undefined until it's complete, null when it isn't one. */
export function parseProxyV2(buf: Buffer): { length: number; address?: string } | null | undefined {
  if (buf.length < 16) return buf.subarray(0, Math.min(buf.length, 12)).equals(SIGNATURE.subarray(0, Math.min(buf.length, 12))) ? undefined : null;
  if (!buf.subarray(0, 12).equals(SIGNATURE) || buf[12]! >> 4 !== 2) return null;
  const length = 16 + buf.readUInt16BE(14);
  if (buf.length < length) return length > MAX_HEADER ? null : undefined;
  const command = buf[12]! & 0x0f;
  const family = buf[13]! >> 4;
  // LOCAL (the load balancer's own health checks): no client address.
  if (command === 0) return { length };
  if (family === 1 && length >= 16 + 12) return { length, address: [...buf.subarray(16, 20)].join(".") };
  if (family === 2 && length >= 16 + 36) {
    const words = [];
    for (let i = 0; i < 16; i += 2) words.push(buf.readUInt16BE(16 + i).toString(16));
    return { length, address: words.join(":") };
  }
  return { length };
}

interface Conn {
  stage: "header" | "connecting" | "open";
  header: Buffer;
  /** Bytes for the HTTPS server, waiting for it to connect or drain. */
  toServer: Buffer[];
  /** Bytes for the client, waiting for it to drain. */
  toClient: Buffer[];
  upstream?: Socket<undefined>;
  closed: boolean;
}

/** Writes what it can now and keeps the rest for `drain`. */
function send(to: Socket<unknown>, queue: Buffer[], chunk?: Buffer) {
  if (chunk?.length) queue.push(chunk);
  while (queue.length) {
    const head = queue[0]!;
    const n = to.write(head);
    if (n < head.length) {
      queue[0] = head.subarray(Math.max(n, 0));
      return;
    }
    queue.shift();
  }
}

export function proxyFront(opts: { hostname: string; port: number; target: { hostname: string; port: number } }) {
  /** Client addresses, by the local port of the front's connection to the HTTPS server. */
  const clients = new Map<number, string>();

  async function connect(s: Socket<Conn>, address: string | undefined) {
    const c = s.data;
    try {
      const up = await Bun.connect<undefined>({
        hostname: opts.target.hostname,
        port: opts.target.port,
        socket: {
          data: (_u, out) => send(s, c.toClient, Buffer.from(out)),
          drain: (u) => send(u, c.toServer),
          close: (u) => {
            clients.delete(u.localPort);
            if (!c.closed) s.end();
          },
          error() {},
        },
      });
      if (c.closed) return void up.end();
      if (address) clients.set(up.localPort, address);
      c.upstream = up;
      c.stage = "open";
      send(up, c.toServer);
    } catch {
      s.end();
    }
  }

  const listener = Bun.listen<Conn>({
    hostname: opts.hostname,
    port: opts.port,
    socket: {
      open(s) {
        s.data = { stage: "header", header: Buffer.alloc(0), toServer: [], toClient: [], closed: false };
      },
      data(s, chunk) {
        const c = s.data;
        if (c.stage === "open") return send(c.upstream!, c.toServer, Buffer.from(chunk));
        if (c.stage === "connecting") return void c.toServer.push(Buffer.from(chunk));
        const buf = Buffer.concat([c.header, Buffer.from(chunk)]);
        const parsed = parseProxyV2(buf);
        if (parsed === undefined) return void (c.header = buf);
        // Not from the load balancer: there is no client address to trust, so no connection.
        if (parsed === null) return void s.end();
        c.header = Buffer.alloc(0);
        c.stage = "connecting";
        if (buf.length > parsed.length) c.toServer.push(buf.subarray(parsed.length));
        void connect(s, parsed.address);
      },
      drain: (s) => send(s, s.data.toClient),
      close(s) {
        s.data.closed = true;
        s.data.upstream?.end();
      },
      error() {},
    },
  });

  return {
    /** The client behind a connection the HTTPS server accepted from the front, by its port. */
    clientOf: (port: number | undefined) => (port === undefined ? undefined : clients.get(port)),
    stop: () => listener.stop(true),
  };
}
