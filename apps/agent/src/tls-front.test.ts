import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { parseProxyV2, proxyFront } from "./tls-front.ts";

// The PROXY v2 front that sits before the enclave's HTTPS server: it must hand the TLS bytes
// through untouched, tell the server who the client was, and refuse connections without a header.

const SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

/** A PROXY v2 header for a TCP-over-IPv4 client. */
function header(ip: string, port: number) {
  const body = Buffer.alloc(12);
  ip.split(".").forEach((o, i) => body.writeUInt8(Number(o), i));
  body.writeUInt8(10, 4), body.writeUInt8(0, 5), body.writeUInt8(0, 6), body.writeUInt8(1, 7);
  body.writeUInt16BE(port, 8);
  body.writeUInt16BE(443, 10);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return Buffer.concat([SIG, Buffer.from([0x21, 0x11]), len, body]);
}

describe("parseProxyV2", () => {
  test("reads an IPv4 client, waits for a partial header, and rejects anything else", () => {
    const h = header("203.0.113.9", 51000);
    expect(parseProxyV2(h)).toEqual({ length: h.length, address: "203.0.113.9" });
    expect(parseProxyV2(h.subarray(0, 10))).toBeUndefined();
    expect(parseProxyV2(h.subarray(0, 20))).toBeUndefined();
    expect(parseProxyV2(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toBeNull();
    // LOCAL (health checks): a header, no address.
    const local = Buffer.concat([SIG, Buffer.from([0x20, 0x00, 0x00, 0x00])]);
    expect(parseProxyV2(local)).toEqual({ length: 16 });
  });
});

// The certificate is made with openssl at test time (no key material in the repo).
describe.skipIf(!Bun.which("openssl"))(`the front${Bun.which("openssl") ? "" : " (skipped: openssl isn't installed)"}`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sikrets-tls-test-"));
  let front: ReturnType<typeof proxyFront>;
  let server: ReturnType<typeof Bun.serve>;
  let port = 0;

  beforeAll(async () => {
    await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -days 1 -keyout ${path.join(dir, "key.pem")} -out ${path.join(dir, "cert.pem")}`.quiet();
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    port = probe.port;
    probe.stop(true);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: readFileSync(path.join(dir, "cert.pem"), "utf8"), key: readFileSync(path.join(dir, "key.pem"), "utf8") },
      fetch: (req, s) => new Response(`client=${front.clientOf(s.requestIP(req)?.port) ?? "unknown"} body=${req.method}`),
    });
    front = proxyFront({ hostname: "127.0.0.1", port, target: { hostname: "127.0.0.1", port: server.port! } });
  });

  afterAll(() => {
    front?.stop();
    server?.stop(true);
  });

  /** Connects to the front, sends `first`, then speaks HTTPS over the same connection. */
  function request(first: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const raw = net.connect(port, "127.0.0.1", () => {
        raw.write(first);
        const secure = tls.connect({ socket: raw, rejectUnauthorized: false, servername: "localhost" }, () => secure.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
        let out = "";
        secure.on("data", (d: Buffer) => (out += d));
        secure.on("end", () => resolve(out));
        secure.on("error", reject);
      });
      raw.on("error", reject);
    });
  }

  test("passes TLS through and names the client from the header", async () => {
    const out = await request(header("198.51.100.7", 40000));
    expect(out).toContain("200 OK");
    expect(out).toContain("client=198.51.100.7");
  });

  test("a connection without a header is closed", async () => {
    const out = await request(Buffer.alloc(0)).catch(() => "");
    expect(out).not.toContain("200 OK");
  });
});
