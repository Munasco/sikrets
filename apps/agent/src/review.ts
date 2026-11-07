import { GENERIC, MODEL, OPENCODE, REVIEW } from "./constants.ts";
import { classes, entropy, fileKind, isWordy, looksRandom } from "./generic.ts";
import { bareSecrets } from "./redact.ts";
import { extract, type Finding } from "./patterns.ts";

// A fast model's second look at the generic findings the rules can't settle (low or medium
// confidence). It never sees a value: only the lines around it with the value masked, and the
// value's shape (length, character classes, entropy, a provider prefix if it has one). It answers
// secret, placeholder or code, with a reason. If it can't answer in time, the findings stay, marked
// as needing review: the check can drop noise, never a finding by failing.
//
// The call goes the way the agent's own model calls go. Inside an agent instance that's the
// gateway's loopback relay (src/opencode.ts) with the instance's stand-in token; the relay adds the
// real key, which the enclave decrypted through KMS with its attestation and which never enters the
// instance. Run in the gateway or locally, it's the key from the environment, as the gateway uses it.

export type Verdict = "secret" | "placeholder" | "code";

export interface Review {
  verdict: Verdict;
  reason: string;
}

/** What the model sees of one finding. */
export interface ReviewItem {
  id: string;
  /** The file's extension and kind (source code, config, other text), and whether it's under tests. */
  file: { ext?: string; kind: string; test: boolean };
  line: number;
  /** The name the value is assigned to: what the code calls it, not the value. */
  name?: string;
  /** The lines around it, the value replaced by REVIEW.mask and any other secret by REVIEW.other. */
  context: string;
  shape: {
    length: number;
    entropy: number;
    lower: boolean;
    upper: boolean;
    digit: boolean;
    symbol: boolean;
    quoted?: boolean;
    /** Only a known provider prefix (sk_live_, ghp_, AKIA…), never more of the value. */
    prefix?: string;
    words: boolean;
    random: boolean;
    uuid: boolean;
    hex: boolean;
  };
}

/** The lines around a finding with its value, and every other secret on them, masked. A line that
 * would still hold any eight characters of the value (it's split, or encoded again nearby) is
 * withheld whole. */
export function maskedContext(text: string, line: number, value: string): string {
  const from = Math.max(0, line - 1 - REVIEW.contextLines);
  const pieces = Array.from({ length: Math.max(0, value.length - 7) }, (_, i) => value.slice(i, i + 8));
  return text
    .split("\n")
    .slice(from, line + REVIEW.contextLines)
    .map((l) => {
      // Mask the value whole before cutting the line, so a cut can't leave part of it unmasked.
      let out = l.split(value).join(REVIEW.mask);
      for (const { value: other } of extract(out)) if (!other.includes(REVIEW.mask)) out = out.split(other).join(REVIEW.other);
      for (const other of bareSecrets(out)) out = out.split(other).join(REVIEW.other);
      if (pieces.some((p) => out.includes(p))) return REVIEW.withheld;
      return out.length > REVIEW.lineChars ? `${out.slice(0, REVIEW.lineChars)}…` : out;
    })
    .join("\n");
}

/** The item for a generic finding, built where the raw value is and holding none of it. */
export function describe(id: string, text: string, value: string, finding: Finding, detail?: { name?: string; quoted?: boolean }): ReviewItem {
  const context = maskedContext(text, finding.line, value);
  const ext = finding.file && /\.([\w-]+)$/.exec(finding.file)?.[1];
  const prefix = REVIEW.prefixes.find((p) => value.startsWith(p));
  return {
    id,
    file: { ...(ext ? { ext } : {}), kind: fileKind(finding.file), test: Boolean(finding.file && GENERIC.testPath.test(finding.file)) },
    line: finding.line,
    ...(detail?.name ? { name: detail.name } : {}),
    context,
    shape: {
      length: value.length,
      entropy: Math.round(entropy(value) * 10) / 10,
      ...classes(value),
      ...(detail?.quoted !== undefined ? { quoted: detail.quoted } : {}),
      ...(prefix ? { prefix } : {}),
      words: isWordy(value),
      random: looksRandom(value),
      uuid: GENERIC.uuid.test(value),
      hex: /^[0-9a-f]+$/i.test(value),
    },
  };
}

/** Where the scanner's model calls go, and the credential they carry: the instance's relay and
 * stand-in token inside an agent instance, else the provider with the key the gateway was given.
 * Undefined when there's neither, or the agent's model isn't one this check can call. */
export function endpoint(env: Record<string, string | undefined> = Bun.env): { base: string; key: string } | undefined {
  if (MODEL.provider !== REVIEW.provider) return undefined;
  let relay: string | undefined;
  try {
    const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : undefined;
    relay = config?.providers?.[MODEL.provider]?.settings?.baseURL;
  } catch {}
  // In an instance, MODEL.keyEnv holds the relay's stand-in token, never the key.
  const key = relay ? env[MODEL.keyEnv] : (env[OPENCODE.keyEnv] ?? env[MODEL.keyEnv]);
  if (!key) return undefined;
  return { base: (relay ?? `https://${MODEL.host}/${OPENCODE.relayPath}`).replace(/\/$/, ""), key };
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, verdict: { type: "STRING", enum: ["secret", "placeholder", "code"] }, reason: { type: "STRING" } },
        required: ["id", "verdict", "reason"],
      },
    },
  },
  required: ["results"],
};

const INSTRUCTIONS = `You review candidate hard-coded credentials that a secret scanner found in source code, config files or pasted text. You never see the value: in each item's context it is replaced by ${REVIEW.mask}, other secrets nearby by ${REVIEW.other}, and a line that would give part of it away reads ${REVIEW.withheld}. ${REVIEW.mask} is a mask, not the text in the file. Judge from the name it is assigned to, the surrounding code, the file, and the value's shape (length, character classes, entropy in bits per character, a known provider prefix, whether it reads as words, looks random, is a UUID or hex).

Answer for each item:
- secret: plausibly a real credential (API key, token, password, signing or encryption key, credentialed connection string) that someone could use and should rotate. Random-looking values under a credential's name in application code or config are secrets.
- placeholder: a stand-in, not a working credential: test fixtures and mocks, documentation examples, dummy or made-up values, values that read as words ("test-password-123"), sample keys in examples.
- code: not a credential at all: an identifier, cache or storage key, i18n key, path, URL, hash or checksum, nonce, ID, enum value, or a protocol constant.
Give a reason in at most 15 words. Return one result per item, with its id.`;

/** Asks the model about a batch; throws on any failure or timeout. */
async function ask(items: ReviewItem[], at: { base: string; key: string }, model: string): Promise<Map<string, Review>> {
  const res = await fetch(`${at.base}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": at.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(items) }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: REVIEW.thinking },
    }),
    signal: AbortSignal.timeout(REVIEW.timeoutMs),
  });
  if (!res.ok) throw new Error(`model returned ${res.status}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const { results } = JSON.parse(text) as { results: { id: string; verdict: Verdict; reason: string }[] };
  const ids = new Set(items.map((i) => i.id));
  const out = new Map<string, Review>();
  for (const r of results ?? []) {
    if (ids.has(r.id) && ["secret", "placeholder", "code"].includes(r.verdict)) out.set(r.id, { verdict: r.verdict, reason: String(r.reason ?? "").slice(0, 200) });
  }
  return out;
}

/** Why an item has no review: no model credential, past REVIEW.maxItems (never sent), its batch
 * failed or timed out, or the model left it out (or gave a verdict outside the schema). */
export type Unreviewed = "skipped" | "capped" | "failed" | "timeout" | "unanswered";

export interface Reviewed {
  reviews: Map<string, Review>;
  /** Each item without a review, and why. */
  unreviewed?: Map<string, Unreviewed>;
  /** Items actually sent to the model. */
  sent?: number;
  /** Batches that failed or timed out; their items have no review. */
  failed: number;
  /** Milliseconds per batch that answered. */
  latencies: number[];
  /** Why nothing was asked, if nothing was. */
  skipped?: string;
}

export type Reviewer = (items: ReviewItem[]) => Promise<Reviewed>;

/** Reviews items in batches, a few at a time. Never throws. */
export async function review(items: ReviewItem[], opts: { env?: Record<string, string | undefined>; model?: string } = {}): Promise<Reviewed> {
  const reviews = new Map<string, Review>();
  const unreviewed = new Map<string, Unreviewed>();
  const latencies: number[] = [];
  if (!items.length) return { reviews, unreviewed, sent: 0, failed: 0, latencies };
  const at = endpoint(opts.env);
  if (!at) return { reviews, unreviewed: new Map(items.map((i) => [i.id, "skipped"])), sent: 0, failed: 0, latencies, skipped: "no model credential here" };
  const sent = Math.min(items.length, REVIEW.maxItems);
  for (const i of items.slice(sent)) unreviewed.set(i.id, "capped");
  const batches: ReviewItem[][] = [];
  for (let i = 0; i < sent; i += REVIEW.batch) batches.push(items.slice(i, Math.min(i + REVIEW.batch, sent)));
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const start = performance.now();
      try {
        for (const [id, r] of await ask(batch, at, opts.model ?? REVIEW.model)) reviews.set(id, r);
        latencies.push(Math.round(performance.now() - start));
      } catch (e) {
        failed++;
        const why = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "failed";
        for (const item of batch) unreviewed.set(item.id, why);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVIEW.concurrency, batches.length) }, worker));
  for (const item of items.slice(0, sent)) if (!reviews.has(item.id) && !unreviewed.has(item.id)) unreviewed.set(item.id, "unanswered");
  return { reviews, unreviewed, sent, failed, latencies };
}
