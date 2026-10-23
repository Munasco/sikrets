// A secret value that refuses to be shown. String conversion, JSON, console.log and Bun.inspect
// all render a mask, so a stray log line, error message or `--json` payload can never leak it to a
// terminal or an agent transcript. The raw value comes out only through `reveal()`, and the
// codebase calls that in exactly two kinds of places: writing to a vault, and building a child
// process environment.

const MASK = "••••••••";

export class Secret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string): Secret {
    if (typeof value !== "string" || value.length === 0) throw new TypeError("A secret must be a non-empty string");
    return new Secret(value);
  }

  reveal(): string {
    return this.#value;
  }

  /** Last few characters only, for telling two keys apart without exposing either. */
  hint(): string {
    return this.#value.length >= 12 ? `${MASK}${this.#value.slice(-4)}` : MASK;
  }

  toString() {
    return MASK;
  }
  toJSON() {
    return MASK;
  }
  [Symbol.toPrimitive]() {
    return MASK;
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Secret(${MASK})`;
  }
}

/** Replaces any known secret values that slipped into free text (e.g. a provider's error body). */
export function redact(text: string, secrets: Iterable<Secret>): string {
  let out = text;
  for (const s of secrets) out = out.split(s.reveal()).join(MASK);
  return out;
}
