import { afterAll, describe, expect, test } from "bun:test";
import { MODEL, OPENCODE, REVIEW } from "./constants.ts";
import { extract } from "./patterns.ts";
import { describe as describeItem, endpoint, maskedContext, review, type Reviewed, type ReviewItem } from "./review.ts";
import { scanText } from "./tools.ts";

// Fake values of a secret's shape, assembled at runtime so no scanner mistakes this file for a leak.
const KEY = "Qx7" + "vR2mK9pL4tW8nB3cY6dF1hJ5sG0aZ";
const STRIPE = "sk" + "_live_" + "51Hx9q8F3kZ0pL1mV7wX2y0R9tB4nC6";

/** A stand-in for the instance's model relay: records what it's sent, answers in the schema. */
function relay(answer: (items: ReviewItem[]) => unknown, status = 200) {
  const seen: { token: string | null; path: string; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      seen.push({ token: req.headers.get("x-goog-api-key"), path: new URL(req.url).pathname, body });
      if (status !== 200) return new Response("nope", { status });
      const items = JSON.parse(JSON.parse(body).contents[0].parts[0].text) as ReviewItem[];
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer(items)) }] } }] });
    },
  });
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { [MODEL.provider]: { settings: { baseURL: `http://127.0.0.1:${server.port}/v1beta` } } } }), [MODEL.keyEnv]: "relay-stand-in-token" };
  return { seen, env, stop: () => server.stop(true) };
}

const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

describe("what the model is sent", () => {
  test("the value is masked, other secrets too, and a line that would leak part of it is withheld", () => {
    const text = [`// vendor client`, `const token = "${KEY}";`, `const other = "${STRIPE}";`, `log(token.slice(0, 12) === "${KEY.slice(0, 12)}");`].join("\n");
    const out = maskedContext(text, 2, KEY);
    expect(out).toContain(`const token = "${REVIEW.mask}";`);
    expect(out).toContain(REVIEW.other);
    expect(out).toContain(REVIEW.withheld);
    expect(out).not.toContain(KEY.slice(0, 8));
    expect(out).not.toContain(STRIPE);
  });

  test("the shape names a provider prefix only, and the item holds nothing of the value", () => {
    const text = `token: "${KEY}"`;
    const [{ value, finding, detail }] = extract(text, "src/client.ts") as [ReturnType<typeof extract>[number]];
    const item = describeItem("1", text, value, finding, detail);
    expect(item.shape).toMatchObject({ length: KEY.length, quoted: true, random: true, words: false });
    expect(item.shape.prefix).toBeUndefined();
    expect(item.name).toBe("token");
    const json = JSON.stringify(item);
    for (let i = 0; i + 8 <= KEY.length; i++) expect(json).not.toContain(KEY.slice(i, i + 8));
  });
});

describe("where the call goes", () => {
  test("inside an instance: the relay, with the instance's stand-in token", () => {
    const at = endpoint({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { [MODEL.provider]: { settings: { baseURL: "http://127.0.0.1:1234/v1beta/" } } } }), [MODEL.keyEnv]: "stand-in", [OPENCODE.keyEnv]: "never-used-here" });
    expect(at).toEqual({ base: "http://127.0.0.1:1234/v1beta", key: "stand-in" });
  });

  test("in the gateway: the provider, with the key the enclave delivered", () => {
    expect(endpoint({ [OPENCODE.keyEnv]: "delivered" })).toEqual({ base: `https://${MODEL.host}/${OPENCODE.relayPath}`, key: "delivered" });
  });

  test("no credential: no call", () => {
    expect(endpoint({})).toBeUndefined();
  });
});

describe("review", () => {
  const text = `export const vendor = new VendorClient({\n  token: "${KEY}",\n});`;
  const item = () => {
    const [{ value, finding, detail }] = extract(text, "src/vendor.ts") as [ReturnType<typeof extract>[number]];
    return describeItem("0", text, value, finding, detail);
  };

  test("asks the relay with the stand-in token, in batches, and never sends the value", async () => {
    const r = relay((items) => ({ results: items.map((i) => ({ id: i.id, verdict: "secret", reason: "looks issued" })) }));
    stops.push(r.stop);
    const items = Array.from({ length: REVIEW.batch + 3 }, (_, i) => ({ ...item(), id: String(i) }));
    const out = await review(items, { env: r.env });
    expect(out.reviews.size).toBe(items.length);
    expect(r.seen).toHaveLength(2);
    for (const s of r.seen) {
      expect(s.token).toBe("relay-stand-in-token");
      expect(s.path).toBe(`/v1beta/models/${REVIEW.model}:generateContent`);
      expect(s.body).not.toContain(KEY);
    }
  });

  test("a failing model leaves findings unreviewed, and doesn't throw", async () => {
    const r = relay(() => ({}), 500);
    stops.push(r.stop);
    const out = await review([item()], { env: r.env });
    expect(out.reviews.size).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.unreviewed?.get("0")).toBe("failed");
  });

  test("each unreviewed item says why: past the cap, or left out of the answer", async () => {
    // Answers every item it's sent but the first.
    const r = relay((items) => ({ results: items.filter((i) => i.id !== "0").map((i) => ({ id: i.id, verdict: "secret", reason: "r" })) }));
    stops.push(r.stop);
    const items = Array.from({ length: REVIEW.maxItems + 2 }, (_, i) => ({ ...item(), id: String(i) }));
    const out = await review(items, { env: r.env });
    expect(out.sent).toBe(REVIEW.maxItems);
    expect(out.unreviewed?.get("0")).toBe("unanswered");
    expect(out.unreviewed?.get(String(REVIEW.maxItems))).toBe("capped");
    expect(out.unreviewed?.get(String(REVIEW.maxItems + 1))).toBe("capped");
    expect(out.unreviewed?.size).toBe(3);
  });

  test("no model credential: every item is skipped, none sent", async () => {
    const out = await review([item()], { env: {} });
    expect(out.sent).toBe(0);
    expect(out.unreviewed?.get("0")).toBe("skipped");
  });

  test("answers for ids it wasn't asked about, or outside the schema, are ignored", async () => {
    const r = relay(() => ({ results: [{ id: "0", verdict: "maybe", reason: "?" }, { id: "9", verdict: "code", reason: "?" }] }));
    stops.push(r.stop);
    expect((await review([item()], { env: r.env })).reviews.size).toBe(0);
  });
});

describe("scan_text with the review", () => {
  const reviewer = (verdict: "secret" | "placeholder" | "code" | undefined) => async (items: ReviewItem[]): Promise<Reviewed> => ({
    reviews: new Map(verdict ? items.map((i) => [i.id, { verdict, reason: "because" }]) : []),
    failed: verdict ? 0 : 1,
    latencies: [],
  });
  const text = `GITHUB_TOKEN=${"ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\nconst client = new Vendor({ token: "${KEY}" });`;

  test("provider findings come first; an unsure generic one the model calls a placeholder is set aside", async () => {
    const r = await scanText({ text }, reviewer("placeholder"));
    expect(r.findings.map((f) => f.type)).toEqual(["github-token"]);
    expect(r.generic).toEqual([]);
    expect(r.dismissed).toHaveLength(1);
    expect(r.dismissed[0]!.review).toEqual({ verdict: "placeholder", reason: "because" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  test("confirmed, it stays with the model's reason", async () => {
    const r = await scanText({ text }, reviewer("secret"));
    expect(r.generic).toHaveLength(1);
    expect(r.generic[0]!.review).toEqual({ verdict: "secret", reason: "because" });
  });

  test("with no answer, it stays, marked as needing review", async () => {
    const r = await scanText({ text }, reviewer(undefined));
    expect(r.generic).toHaveLength(1);
    expect(r.generic[0]!.review).toBe("needs review");
    expect(r.generic[0]!.unreviewed).toBe("unanswered");
    expect(r.dismissed).toEqual([]);
  });

  test("the summary counts only what was sent", async () => {
    const r = await scanText({ text }, async (items) => ({ reviews: new Map(), unreviewed: new Map(items.map((i) => [i.id, "skipped"])), sent: 0, failed: 0, latencies: [], skipped: "no model credential here" }));
    expect(r.generic[0]!.unreviewed).toBe("skipped");
    expect(r.review).toMatchObject({ asked: 0, capped: 0, answered: 0 });
  });
});
