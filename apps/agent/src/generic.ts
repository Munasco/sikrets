import services from "../data/services.json";
import { GENERIC } from "./constants.ts";

// The generic rule: `api_key = "…"` style assignments with no provider prefix to go on. Names and
// values in code look like this all the time (`pressed_keys = window.collect_pressed_keys()`,
// `KeyCode`, `secretSauce = computeSecretSauce(input)`), so a match counts only when the name is a
// secret's name, the value is a literal (quoted, in source files) and doesn't look like code or a
// word. What survives gets a confidence, so the few that are still unsure can be ranked last and
// checked (src/review.ts) instead of drowning the provider findings.

export type Confidence = "high" | "medium" | "low";

/** A name that contains a secret's keyword, an optional type annotation (`API_KEY: &str =`,
 * `apiKey: string =`), an assignment (not a comparison), and what follows: group 1 is the name,
 * 2 the opening quote (if any), 3 the run up to the next quote or the line's end (looked ahead
 * at, not consumed, so a second assignment on the same line still matches). */
export const GENERIC_RE =
  /(?<![\w$])([\w$.-]*?(?:key|secret|token|passw(?:or)?d|pwd|passphrase|credential|auth)[\w$.-]*)["']?[ \t]*(?::[ \t]*[&\w'<>[\]]{1,30}(?:[ \t]+[\w<>[\]]{1,20})?[ \t]*(?==[^=>]))?(?<![=!<>])(?::=|=>|=|:)(?!=)[ \t]*(["'`]?)(?=([^"'`\r\n]{1,300}))/gi;

export const GENERIC_KEYWORDS = ["key", "secret", "token", "passw", "pwd", "passphrase", "credential", "auth"];

/** A name's words, lowercase: `apiKey`, `API_KEY`, `api-key` and `x.apiKey` are all [api, key]. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.$-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Words that say whose credential a `…_KEY` or `…Token` is: the credential words, and every
 * service in the Sikrets catalog (STRIPE_KEY, openaiToken). */
const OWNERS = new Set([...GENERIC.owners, ...(services as { id: string }[]).map((s) => s.id).filter((id) => /^[a-z]+$/.test(id) && !GENERIC.notOwners.includes(id))]);

/** How strongly a name says "secret": 2 for api_key, clientSecret, DB_PASSWORD, STRIPE_KEY; 1 for
 * a bare `key`, `auth` or `token`, one owned by a word that names nothing in particular
 * (`storefrontToken`), or a plural (`tokens`), all of which name plenty of other things; 0 for
 * KeyCode, keyboard_state, token_url, secretSauce, cacheKey, NEXT_PUBLIC_…_KEY. The keyword must
 * be a word of its own and the last one, apart from qualifiers like `_prod` or `_b64`. */
export function nameStrength(name: string): 0 | 1 | 2 {
  const ws = words(name.split(".").pop() ?? name);
  if (ws.some((w) => GENERIC.publicWords.includes(w))) return 0;
  let i = ws.length - 1;
  while (i > 0 && (GENERIC.qualifiers.includes(ws[i]!) || /^v?\d+$/.test(ws[i]!))) i--;
  const w = ws[i];
  if (!w) return 0;
  if (GENERIC.strong.includes(w) || GENERIC.compound.test(w)) return 2;
  if (GENERIC.plural.includes(w)) return 1;
  if (!GENERIC.keyish.includes(w)) return 0;
  // `key`, `token` and `auth` take their meaning from the word before: STRIPE_KEY and authToken
  // are credentials, cacheKey and nextToken aren't, and a bare `key` could be either.
  const before = ws[i - 1];
  if (!before) return 1;
  if (GENERIC.notOwners.includes(before)) return 0;
  return OWNERS.has(before) ? 2 : 1;
}

/** Random bytes, encoded: the character class (lower, upper, digit, other) changes often.
 * `ab12cd34…` and base64 do; `1700000000abcdef`, `owner.repo/pull/12` and words don't. */
export function looksRandom(value: string): boolean {
  const cls = (c: string) => (/[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /\d/.test(c) ? 2 : 3);
  let changes = 0;
  for (let i = 1; i < value.length; i++) if (cls(value[i]!) !== cls(value[i - 1]!)) changes++;
  return changes >= (value.length - 1) * GENERIC.randomChanges && !isWordy(value);
}

export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Words joined up (`getSecretFromVault`, `SOME_CONSTANT_NAME`, `dashboard.settings.title`):
 * letters only, in pieces long and pronounceable enough to be words. A random string of letters
 * changes case every character or two, or has long runs of consonants. */
export function isIdentifier(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z_.:/-]*$/.test(value)) return false;
  const parts = words(value.replace(/[:/]/g, "."));
  if (!parts.length) return false;
  const letters = parts.join("").length;
  if (letters / parts.length < 3) return false;
  return parts.every((p) => p.length <= 3 || (/[aeiouy]/.test(p) && !/[^aeiouy]{5,}/.test(p)));
}

/** Words with separators and maybe a number (`session:abc-def:v1`, `test-api-key-123`,
 * `sk-ant-oat01-fake-token`, `TestPassword123!`, `bucket/path/file2.txt`): split at separators,
 * case changes and digits, the pieces are pronounceable words, short bits and numbers, three
 * letters long on average. Random strings break into one- and two-character pieces (`q8F3kZ0p`). */
export function isWordy(value: string): boolean {
  // Hex is what random bytes look like; never words.
  if (/^[0-9a-f-]+$/i.test(value) && /\d/.test(value)) return false;
  const pieces = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .filter(Boolean);
  let letters = 0;
  let count = 0;
  let word = false;
  for (const p of pieces) {
    // Counters, timestamps, the digits in a fake.
    if (/^\d+$/.test(p)) {
      if (p.length > GENERIC.wordyDigits) return false;
      continue;
    }
    letters += p.length;
    count++;
    // Words are short and have vowels; a long run of letters is random however it reads.
    const pronounceable = p.length <= GENERIC.wordLength && /[aeiouy]/i.test(p) && !/[^aeiouy]{6,}/i.test(p);
    // Abbreviations (`http`, `sha`, `id`) are fine; a longer unpronounceable piece is random.
    if (p.length >= 5 && !pronounceable) return false;
    if (p.length >= 4 && pronounceable) word = true;
  }
  return word && letters / count >= 3;
}

export type FileKind = "code" | "config" | "text";

/** Source code, config (.env, YAML, TOML, shell), or anything else (docs, pasted chat text). */
export function fileKind(file?: string): FileKind {
  if (!file) return "text";
  if (GENERIC.code.test(file)) return "code";
  if (GENERIC.config.test(file)) return "config";
  return "text";
}

export interface Judged {
  value: string;
  confidence: Confidence;
  /** The assignment's name (not secret: it's what the code calls the value). */
  name: string;
  quoted: boolean;
}

/** Character classes in a value. */
export function classes(value: string) {
  return { lower: /[a-z]/.test(value), upper: /[A-Z]/.test(value), digit: /\d/.test(value), symbol: /[^A-Za-z0-9]/.test(value) };
}

/** Whether a generic match is a secret, and how sure that is; undefined if it's not one. With
 * `redacting`, for keeping pasted text from the model, made-up looking values count too. */
export function judge(m: RegExpMatchArray, text: string, file: string | undefined, placeholder: RegExp, redacting = false): Judged | undefined {
  const [whole, name = "", quote = "", run = ""] = m;
  const strength = nameStrength(name);
  if (!strength) return undefined;
  const kind = fileKind(file);
  let value: string;
  if (quote) {
    // The literal must close with the quote it opened with.
    if (text[(m.index ?? 0) + whole.length + run.length] !== quote) return undefined;
    value = run.replace(GENERIC.authScheme, "");
  } else {
    // In source code an unquoted value is an expression, never a literal; a plural name
    // (`keys = …`) holds a collection, not a key.
    if (kind === "code" || strength < 2) return undefined;
    value = /^\S*/.exec(run)![0];
    // `KEY=value # comment` and YAML's `key: value` end at whitespace; trailing commas and
    // semicolons are code or a list.
    if (GENERIC.unquotedCode.test(value)) return undefined;
  }
  if (value.length < GENERIC.minLength || value.length > GENERIC.maxLength) return undefined;
  if (/\s/.test(value) || GENERIC.interpolation.test(value) || GENERIC.quotedCode.test(value)) return undefined;
  if (placeholder.test(value) || GENERIC.notSecret.test(value)) return undefined;
  if (isIdentifier(value)) return undefined;
  const h = entropy(value);
  if (h < GENERIC.entropy) return undefined;
  const inTest = Boolean(file && GENERIC.testPath.test(file));
  // Words and numbers: a slug, a path or an id, or a made-up password. A passphrase under a
  // password's name outside the tests is still worth a look.
  const wordy = isWordy(value);
  // Hiding a pasted value from the model costs nothing if it was a fake; reporting one costs the
  // reader's attention. So these two only decide what's reported.
  if (!redacting && wordy && (inTest || !GENERIC.passwordWords.includes(words(name).at(-1) ?? ""))) return undefined;
  // A name that could be anything's key needs a value that could only be a credential.
  if (!redacting && strength < 2 && !looksRandom(value)) return undefined;

  // What's left is a literal of the right shape under a secret's name. Rank it.
  const c = classes(value);
  const kinds = [c.lower, c.upper, c.digit].filter(Boolean).length;
  let score = strength === 2 ? 2 : 0;
  if (kind !== "code") score += 1;
  if (kinds === 3 || (kinds === 2 && c.symbol)) score += 1;
  if (h >= 4.2 && value.length >= 24) score += 1;
  if (inTest) score -= 2;
  if (GENERIC.uuid.test(value) || (kinds === 1 && !c.symbol)) score -= 1;
  if (wordy) score = Math.min(score, 1);
  const confidence: Confidence = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return { value, confidence, name, quoted: Boolean(quote) };
}
