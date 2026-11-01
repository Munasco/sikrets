import { describe, expect, test } from "bun:test";
import { build, convert, trim } from "../scripts/gitleaks.ts";
import { GITLEAKS_PATTERNS, GITLEAKS_SKIPPED } from "./gitleaks.ts";
import { PATTERNS, scan } from "./patterns.ts";
import { shield } from "./redact.ts";
import { GITLEAKS } from "./constants.ts";

// Fake values shaped like real keys, assembled at runtime so no scanner mistakes this file for a leak.
const FAKE = {
  github: "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  age: "AGE-SECRET-KEY-1" + "QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW0S3JN54KHCE6M",
  linear: "lin" + "_api_" + "k3j9x0q2m8v7c6b5n4z1a2s3d4f5g6h7j8k9l0p1",
  doppler: "dp" + ".pt." + "k3j9x0q2m8v7c6b5n4z1a2s3d4f5g6h7j8k9l0p1abc",
};

describe("gitleaks rules", () => {
  test("src/gitleaks.ts is what the vendored config compiles to", async () => {
    expect(build().source).toBe(await Bun.file(new URL("./gitleaks.ts", import.meta.url)).text());
  });

  test("every rule is either compiled or listed as skipped, with a reason", () => {
    const { rules, kept, skipped } = build();
    expect(kept + skipped.length).toBe(rules);
    expect(GITLEAKS_PATTERNS.length).toBe(kept);
    expect(GITLEAKS_SKIPPED.map((s) => s.id).sort()).toEqual(["generic-api-key", "pkcs12-file", ...GITLEAKS.slow].sort());
    expect(GITLEAKS_PATTERNS.length).toBeGreaterThan(200);
  });

  test("finds keys only gitleaks knows, under the provider's name", () => {
    expect(scan(FAKE.age).map((f) => f.type)).toEqual(["age-secret-key"]);
    expect(scan(`LINEAR_API_KEY=${FAKE.linear}`).map((f) => [f.type, f.service])).toEqual([["linear-api-key", "linear"]]);
    expect(scan(`token: ${FAKE.doppler}`).map((f) => f.type)).toEqual(["doppler-api-token"]);
  });

  test("reports a key once, under our name, when gitleaks matches it too", () => {
    expect(scan(`GITHUB_TOKEN=${FAKE.github}`).map((f) => f.type)).toEqual(["github-token"]);
  });

  test("redacts gitleaks-only keys in chat", () => {
    const r = shield(`can you check ${FAKE.doppler} and ${FAKE.age}?`);
    expect(r.secrets.size).toBe(2);
    expect(r.text).not.toContain(FAKE.doppler);
    expect(r.text).not.toContain(FAKE.age);
  });

  test("file-only rules and allowlists apply as in gitleaks", () => {
    const yaml = "kind: Secret\ndata:\n  password: c2VjcmV0cGFzc3dvcmQxMjM0NQ==\n";
    expect(scan(yaml, "k8s/secret.yaml").map((f) => f.type)).toContain("kubernetes-secret-yaml");
    // The same text pasted in chat has no file name, so the rule doesn't run.
    expect(scan(yaml).map((f) => f.type)).not.toContain("kubernetes-secret-yaml");
    // Templated values are allowlisted.
    expect(scan("kind: Secret\ndata:\n  password: {{ .Values.password }}\n", "k8s/secret.yaml")).toHaveLength(0);
  });

  test("each rule stays fast on a crafted 60 KB message (JS regexes backtrack; Go's don't)", () => {
    const shapes = (k: string) => [(k + " ").repeat(60_000 / (k.length + 1)), (k + "_key: \"aB3dE5gH7jK9mN1pQ3sT5vX7z\"\n").repeat(60_000 / (k.length + 35)), (k + " a").padEnd(60_000, "a"), (k + " -u ").repeat(60_000 / (k.length + 4))];
    const slow: string[] = [];
    for (const p of PATTERNS) {
      for (const text of (p.keywords ?? ["key"]).flatMap(shapes)) {
        const start = performance.now();
        for (const _ of text.matchAll(p.re));
        if (performance.now() - start > 50) slow.push(p.id);
      }
    }
    expect([...new Set(slow)]).toEqual([]);
  });
});

describe("Go regex conversion", () => {
  const js = (go: string) => {
    const { source, flags } = convert(go);
    return new RegExp(source, flags);
  };

  test("a mid-pattern flag covers the rest of its group, across alternatives", () => {
    const re = js("\\b(p8e-(?i)[a-z0-9]{4}|x(?i)y)\\b");
    expect(re.test("p8e-AbC1")).toBe(true);
    expect(re.test("P8E-abc1")).toBe(false);
    expect(js("a(?i)b|c").test("C")).toBe(true);
    expect(js("(?:a(?i)b)|c").test("C")).toBe(false);
  });

  test("a leading flag becomes a regex flag", () => {
    expect(convert("(?i)abc")).toEqual({ source: "abc", flags: "i" });
  });

  test("Go-only syntax", () => {
    expect(js("\\b(pat[[:alnum:]]{3})\\b").test("patA1z")).toBe(true);
    expect(js("^abc\\z").test("abc")).toBe(true);
    expect(js("(?P<key>ab)c").exec("abc")?.[1]).toBe("ab");
    // In Go `[^]]` is "not ]"; in JS `[^]` is "anything".
    expect(js("^[^]]+$").test("a]")).toBe(false);
    expect(() => convert("\\pL+")).toThrow();
  });

  test("trim drops leading lazy prefixes only", () => {
    expect(trim("[\\w.-]{0,50}?(?i:[\\w.-]{0,50}?(?:cohere))")).toBe("(?i:(?:cohere))");
    expect(trim("a[\\w.-]{0,50}?b")).toBe("a[\\w.-]{0,50}?b");
  });
});
