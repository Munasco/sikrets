import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { chat, type ChatMessage } from "./agent.ts";
import { MODEL, SERVER } from "./constants.ts";

// A small server: the chat page, a streaming chat API (server-sent events), an access-code gate
// for the hosted demo, and per-client rate limits so strangers can't run up the model bill.

const PUBLIC = path.join(import.meta.dir, "..", "public");
const signingKey = SERVER.accessCode ? createHmac("sha256", "sikrets-agent").update(SERVER.accessCode).digest() : undefined;

const sign = (expires: number) => `${expires}.${createHmac("sha256", signingKey!).update(String(expires)).digest("base64url")}`;

function authed(req: Request): boolean {
  if (!signingKey) return true;
  const cookie = req.headers.get("cookie") ?? "";
  const value = new RegExp(`(?:^|;\\s*)${SERVER.cookie}=([^;]+)`).exec(cookie)?.[1];
  if (!value) return false;
  const [exp] = value.split(".");
  if (!exp || Number(exp) < Date.now()) return false;
  const want = Buffer.from(sign(Number(exp)));
  const got = Buffer.from(value);
  return want.length === got.length && timingSafeEqual(want, got);
}

function codeMatches(code: string): boolean {
  const a = createHmac("sha256", "cmp").update(code).digest();
  const b = createHmac("sha256", "cmp").update(SERVER.accessCode ?? "").digest();
  return timingSafeEqual(a, b);
}

const minute = new Map<string, number[]>();
let day = { date: "", count: 0 };
function limited(client: string): string | undefined {
  const now = Date.now();
  const hits = (minute.get(client) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= SERVER.perMinute) return "Too many messages; wait a minute.";
  hits.push(now);
  minute.set(client, hits);
  const today = new Date().toISOString().slice(0, 10);
  if (day.date !== today) day = { date: today, count: 0 };
  if (++day.count > SERVER.perDay) return "The demo's daily limit is used up; try tomorrow.";
  return undefined;
}

const clientOf = (req: Request, server: Bun.Server<unknown>) =>
  req.headers.get("cloudfront-viewer-address")?.replace(/:\d+$/, "") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? server.requestIP(req)?.address ?? "unknown";

const failedLogins = new Map<string, number[]>();

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { ...SECURITY_HEADERS, ...headers } });

const server = Bun.serve({
  port: SERVER.port,
  hostname: SERVER.host,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(Bun.file(path.join(PUBLIC, "index.html")), { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }

    if (url.pathname === "/api/me") return json({ authed: authed(req), gated: Boolean(signingKey), model: MODEL.id });

    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = clientOf(req, server);
      const fails = (failedLogins.get(ip) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
      if (fails.length >= 8) return json({ error: "Too many attempts; try again in 15 minutes." }, 429);
      const { code } = (await req.json().catch(() => ({}))) as { code?: string };
      if (!signingKey || !code || !codeMatches(code.trim())) {
        failedLogins.set(ip, [...fails, Date.now()]);
        return json({ error: "That code isn't right." }, 401);
      }
      const expires = Date.now() + SERVER.sessionDays * 86_400_000;
      return json({ ok: true }, 200, { "set-cookie": `${SERVER.cookie}=${sign(expires)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SERVER.sessionDays * 86_400}` });
    }

    if (url.pathname === "/attestation" || url.pathname === "/api/attestation") {
      const file = Bun.file(SERVER.attestationFile);
      const data = (await file.exists()) ? await file.json() : { enclave: false, note: "This server isn't running inside a Nitro Enclave yet; no attestation document is available." };
      return json(data);
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!authed(req)) return json({ error: "Enter the access code first." }, 401);
      const busy = limited(clientOf(req, server));
      if (busy) return json({ error: busy }, 429);
      const body = (await req.json().catch(() => ({}))) as { messages?: ChatMessage[] };
      const messages = (body.messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
      if (!messages.length || messages.at(-1)!.role !== "user") return json({ error: "Send at least one user message." }, 400);

      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (data: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
          const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15_000);
          try {
            for await (const ev of chat(messages, req.signal)) send(ev);
          } catch (error) {
            send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          } finally {
            clearInterval(ping);
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { ...SECURITY_HEADERS, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`Sikrets security agent on http://${server.hostname}:${server.port} (${MODEL.id}${SERVER.accessCode ? ", access code required" : ""})`);
