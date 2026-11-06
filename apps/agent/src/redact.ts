import { entropy, extract, PLACEHOLDER, redact, sha256 } from "./patterns.ts";
import { LIMITS } from "./constants.ts";

// Keeps pasted secrets away from the model. Each one is swapped for a placeholder that names it
// (type, prefix…last4, a hash prefix) before the message is stored or sent anywhere; the real value
// stays in this process's memory, per session, so tools can use it. Nothing here is persisted.

export const tagFor = (redacted: string, sha256: string) => `[[secret ${redacted} #${sha256.slice(0, 8)}]]`;

/** Bare tokens that look like a secret but have no recognisable prefix or `name=` around them:
 * long and high-entropy. Over-redacting a commit hash costs nothing; missing a key costs the key.
 * Only for chat text; scan findings keep to the named patterns. */
export function bareSecrets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w/.-])[A-Za-z0-9_+/=-]{32,512}(?![\w/.-])/g)) {
    const v = m[0];
    if (PLACEHOLDER.test(v) || entropy(v) < 3.5) continue;
    if (/^[A-Za-z]+$/.test(v) || /^\d+$/.test(v)) continue;
    out.push(v);
  }
  return out;
}

/** The text with every secret replaced by its placeholder, and the secrets found. */
export function shield(text: string): { text: string; secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  let out = text;
  // Longest first, so a key that contains another match is replaced whole.
  for (const { value, finding } of extract(text, undefined, { redacting: true }).sort((a, b) => b.value.length - a.value.length)) {
    const tag = tagFor(finding.redacted, finding.sha256);
    secrets.set(tag, value);
    out = out.split(value).join(tag);
  }
  for (const value of bareSecrets(out)) {
    const tag = tagFor(redact(value), sha256(value));
    secrets.set(tag, value);
    out = out.split(value).join(tag);
  }
  return { text: out, secrets };
}

const OPAQUE = [Date, RegExp, Map, Set, Promise, ArrayBuffer];

/** Message fields that hold what people and tools wrote. Everything else in a model request
 * (ids, provider metadata such as Gemini's base64 thought signatures) must pass through untouched:
 * those are high-entropy by design, and redacting them breaks the request. */
const TEXT_KEYS = new Set(["text", "content"]);

/** Applies fn to strings in a value, in place for arrays and objects (class instances too:
 * opencode's request messages are schema classes). With `textOnly`, only strings under
 * TEXT_KEYS are changed. */
function mapStrings(v: unknown, fn: (s: string) => string, textOnly = false, key?: string, seen = new WeakSet<object>()): unknown {
  if (typeof v === "string") return !textOnly || (key !== undefined && TEXT_KEYS.has(key)) ? fn(v) : v;
  if (!v || typeof v !== "object" || seen.has(v)) return v;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = mapStrings(v[i], fn, textOnly, key, seen);
  } else if (!Object.isFrozen(v) && !ArrayBuffer.isView(v) && !OPAQUE.some((t) => v instanceof t)) {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) o[k] = mapStrings(o[k], fn, textOnly, k, seen);
  }
  return v;
}

export class Vault {
  private sessions = new Map<string, { at: number; secrets: Map<string, string> }>();

  /** Redacts text for a session and remembers the secrets it held. */
  shield(session: string, text: string): { text: string; hidden: number } {
    const r = shield(text);
    if (r.secrets.size) {
      const entry = this.sessions.get(session) ?? { at: Date.now(), secrets: new Map() };
      for (const [tag, value] of r.secrets) entry.secrets.set(tag, value);
      entry.at = Date.now();
      this.sessions.delete(session);
      this.sessions.set(session, entry);
      this.prune();
    }
    return { text: r.text, hidden: r.secrets.size };
  }

  /** Redacts every string inside a value (in place), e.g. a model request's messages. */
  shieldAll<T>(session: string, value: T): T {
    return mapStrings(value, (s) => this.shield(session, s).text, true) as T;
  }

  /** Redacts every string inside a value (in place), whatever its key: an MCP tool's input or
   * result, which has no fixed shape. */
  shieldDeep<T>(session: string, value: T): T {
    return mapStrings(value, (s) => this.shield(session, s).text) as T;
  }

  /** A copy of a tool's input with this session's placeholders swapped back for the real values. */
  reveal<T>(session: string, input: T): T {
    const secrets = this.sessions.get(session)?.secrets;
    const copy = structuredClone(input);
    if (!secrets?.size) return copy;
    return mapStrings(copy, (s) => {
      for (const [tag, value] of secrets) s = s.split(tag).join(value);
      return s;
    }) as T;
  }

  /** True if any secret this vault holds appears in the text, raw or JSON-escaped. */
  leaks(text: string): boolean {
    for (const { secrets } of this.sessions.values()) {
      for (const value of secrets.values()) {
        if (text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))) return true;
      }
    }
    return false;
  }

  forget(session: string) {
    this.sessions.delete(session);
  }

  private prune() {
    const cutoff = Date.now() - LIMITS.sessionHours * 3_600_000;
    for (const [id, e] of this.sessions) {
      if (this.sessions.size > LIMITS.sessions || e.at < cutoff) this.sessions.delete(id);
      else break;
    }
  }
}
