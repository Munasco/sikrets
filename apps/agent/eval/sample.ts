// Random strings a regex matches, for synthetic true positives: every rule gets values of its own
// shape, made at run time, so no fixture holds anything that looks like a real key. Covers the
// regex syntax the rules use (classes, groups, alternation, counted repeats, inline flags, a back
// reference); lookarounds and \b generate nothing, and the caller checks the rule matches.

type Node =
  | { t: "seq"; items: Node[] }
  | { t: "alt"; options: Node[] }
  | { t: "group"; node: Node; index?: number }
  | { t: "set"; chars: string }
  | { t: "lit"; c: string }
  | { t: "ref"; index: number }
  | { t: "none" }
  | { t: "rep"; node: Node; min: number; max: number; lazy: boolean };

const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
const DIGIT = "0123456789";
const WORD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

function escapeSet(c: string): string {
  switch (c) {
    case "d": return DIGIT;
    case "w": return WORD;
    case "s": return " ";
    case "S": return WORD;
    case "D": return "abcXYZ_-";
    case "W": return " -.:/";
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    default: return c;
  }
}

/** Parses a JavaScript regex source into a tree. */
export function parse(source: string): Node {
  let i = 0;
  let groups = 0;
  const alt = (): Node => {
    const options = [seq()];
    while (source[i] === "|") {
      i++;
      options.push(seq());
    }
    return options.length === 1 ? options[0]! : { t: "alt", options };
  };
  const seq = (): Node => {
    const items: Node[] = [];
    while (i < source.length && source[i] !== "|" && source[i] !== ")") items.push(quantified(atom()));
    return { t: "seq", items };
  };
  const quantified = (node: Node): Node => {
    const c = source[i];
    let min: number, max: number;
    if (c === "*") (min = 0), (max = Infinity), i++;
    else if (c === "+") (min = 1), (max = Infinity), i++;
    else if (c === "?") (min = 0), (max = 1), i++;
    else if (c === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(i))) {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))!;
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : min;
      i += m[0].length;
    } else return node;
    const lazy = source[i] === "?";
    if (lazy) i++;
    return quantified({ t: "rep", node, min, max, lazy });
  };
  const atom = (): Node => {
    const c = source[i++]!;
    if (c === "(") {
      let index: number | undefined;
      let skip = false;
      if (source[i] === "?") {
        const m = /^\?(?:<([=!])|([=!])|<[A-Za-z_]\w*>|[-imsx]*:)/.exec(source.slice(i));
        if (!m) throw new Error(`group at ${i}`);
        if (m[1] || m[2]) skip = true;
        else if (m[0].startsWith("?<")) index = ++groups;
        i += m[0].length;
      } else index = ++groups;
      const node = alt();
      i++; // ")"
      return skip ? { t: "none" } : { t: "group", node, index };
    }
    if (c === "[") return set();
    if (c === ".") return { t: "set", chars: WORD };
    if (c === "^" || c === "$") return { t: "none" };
    if (c === "\\") return escape();
    return { t: "lit", c };
  };
  const escape = (): Node => {
    const c = source[i++]!;
    if (c === "b" || c === "B" || c === "A" || c === "z") return { t: "none" };
    if (/\d/.test(c)) return { t: "ref", index: Number(c) };
    if (c === "x") {
      const hex = source.slice(i, i + 2);
      i += 2;
      return { t: "lit", c: String.fromCharCode(parseInt(hex, 16)) };
    }
    const chars = escapeSet(c);
    return chars.length === 1 ? { t: "lit", c: chars } : { t: "set", chars };
  };
  const set = (): Node => {
    let negate = false;
    if (source[i] === "^") (negate = true), i++;
    let chars = "";
    let first = true;
    while (i < source.length && (source[i] !== "]" || first)) {
      first = false;
      let c = source[i++]!;
      if (c === "\\") {
        const e = source[i++]!;
        if (e === "x") {
          c = String.fromCharCode(parseInt(source.slice(i, i + 2), 16));
          i += 2;
        } else {
          const s = escapeSet(e);
          if (s.length > 1) {
            chars += s;
            continue;
          }
          c = s;
        }
      }
      if (source[i] === "-" && source[i + 1] !== "]" && i + 1 < source.length) {
        i++;
        let end = source[i++]!;
        if (end === "\\") {
          const e = source[i++]!;
          end = e === "x" ? String.fromCharCode(parseInt(source.slice(i, (i += 2)), 16)) : escapeSet(e);
        }
        for (let k = c.charCodeAt(0); k <= end.charCodeAt(0); k++) chars += String.fromCharCode(k);
      } else chars += c;
    }
    i++; // "]"
    if (negate) chars = [...PRINTABLE].filter((x) => !chars.includes(x)).join("");
    return { t: "set", chars };
  };
  const tree = alt();
  return tree;
}

/** A seeded random number generator (mulberry32). */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One string the regex matches (usually: lookarounds are ignored). Gaps (`[\w.-]{0,20}`) are
 * left short; the secret's own run (`[a-z0-9]{32}`, `{20,}`) is filled to its length. */
export function sample(source: string, random: () => number): string {
  const captured: string[] = [];
  const pick = (s: string) => s[Math.floor(random() * s.length)] ?? "";
  const gen = (n: Node): string => {
    switch (n.t) {
      case "seq":
        return n.items.map(gen).join("");
      case "alt":
        return gen(n.options[Math.floor(random() * n.options.length)]!);
      case "group": {
        const s = gen(n.node);
        if (n.index) captured[n.index] = s;
        return s;
      }
      case "set":
        // Prefer letters and digits over punctuation, the way keys are made.
        return pick(/[A-Za-z0-9]/.test(n.chars) && random() < 0.9 ? n.chars.replace(/[^A-Za-z0-9]/g, "") : n.chars);
      case "lit":
        return n.c;
      case "ref":
        return captured[n.index] ?? "";
      case "none":
        return "";
      case "rep": {
        const gap = n.lazy || (n.min === 0 && n.max <= 50);
        const count = gap ? n.min : n.max === Infinity ? n.min + Math.floor(random() * 8) : n.min + Math.floor(random() * (Math.min(n.max, n.min + 24) - n.min + 1));
        return Array.from({ length: count }, () => gen(n.node)).join("");
      }
    }
  };
  return gen(parse(source));
}
