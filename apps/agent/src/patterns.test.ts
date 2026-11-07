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

describe("generic rule", () => {
  // Fake values of a secret's shape, made here so no scanner mistakes this file for a leak.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // mulberry32: deterministic, and random enough that every character class turns up.
  let seed = 7;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fake = (n: number, set = chars) => Array.from({ length: n }, () => set[Math.floor(next() * set.length)]).join("");
  const generic = (text: string, file?: string) => scan(text, file).filter((f) => f.type === "generic-secret");

  test("code that names keys, tokens and secrets isn't a secret", () => {
    const code: [string, string][] = [
      ["apps/game/src/window.rs", "let pressed_keys = window.collect_pressed_keys();"],
      ["runtime/input/src/keys.rs", "pub fn with_modifier_keys(keys: HashMap<KeyCode, Modifier>) -> Self {"],
      ["runtime/input/src/keys.rs", "KeyCode::Escape => self.keyboard_state.release(KeyCode::Escape),"],
      ["io/apple/src/decode.rs", "let keyboard_state = KeyboardState::from_raw(raw);"],
      ["src/sauce.ts", "const secretSauce = computeSecretSauce(input);"],
      ["src/sauce.ts", "secretSauce = 'the-recipe-is-in-the-vault-folder'"],
      ["src/auth.ts", "const authToken = await session.getAuthTokenForUser(userId);"],
      ["src/auth.ts", "if (token === expectedTokenFromHeader) return next();"],
      ["src/auth.go", "if apiKey != cfg.APIKeyFromEnvironment {"],
      ["src/auth.go", "apiKey := os.Getenv(\"OPENAI_API_KEY\")"],
      ["src/auth.py", "api_key = os.environ[\"STRIPE_SECRET_KEY\"]"],
      ["src/auth.py", "password: str = field(default_factory=generate_password_hash)"],
      ["src/lib.rs", "const TOKEN_ENDPOINT: &str = \"https://oauth2.googleapis.com/token\";"],
      ["src/lib.rs", "fn api_key(&self) -> Option<&SecretString> { self.api_key.as_ref() }"],
      ["src/cache.ts", "const cacheKey = `user:${userId}:profile:v2`;"],
      ["src/cache.ts", "const CHUNK_RELOAD_GUARD_KEY = \"t3code:chunk-reload-guard:v1\";"],
      ["src/llm.ts", "const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;"],
      ["src/llm.ts", "inputTokens: usage.prompt_tokens_details.cached_tokens,"],
      ["src/i18n.ts", "{ key: \"settings.security.rotateKeysDescription\", label: t(\"rotate\") }"],
      ["src/list.tsx", "<Row key={`${thread.id}-${message.id}`} cacheKey={thread.cacheKeyForRow} />"],
      ["src/s3.ts", "await s3.getObject({ Bucket: bucket, Key: \"incoming/2024/report-final.pdf\" });"],
      ["src/types.ts", "export type SessionTokenStore = Map<string, SessionTokenRecord>;"],
      ["src/Auth.java", "private final String accessTokenUrl = config.getString(\"oauth.accessTokenUrl\");"],
      ["src/Auth.kt", "val refreshToken: String = tokenStore.refreshTokenFor(account) ?: return null"],
      ["src/ws.ts", "headers[\"Sec-WebSocket-Key\"] = createNonce(16).toString(\"base64\");"],
      ["src/regex.ts", "const TOKEN_PATTERN = \"\\\\b(?:ghp|gho)_[A-Za-z0-9]{36}\\\\b\";"],
      ["test/auth.test.ts", "const password = \"Correct-Horse-Battery-Staple-42\";"],
      ["test/auth.test.ts", "accessToken: \"test-access-token-for-relogin-123\","],
      ["test/slack.test.ts", "token: 'xoxb-test-token-from-oauth',"],
      ["test/s3.test.ts", "{ accessKeyId: \"AKIAIOSFODNN7EXAMPLE\", secretAccessKey: \"test-secret-key\" }"],
      ["db/config.ts", "url: \"postgres://postgres:postgres@localhost:5432/app\","],
      ["db/config.ts", "url: `postgresql://${user}:${password}@${host}:5432/${db}`,"],
      ["README.md", "Set `OPENAI_API_KEY=<your key>` and `DATABASE_URL=postgres://user:changeme@db:5432/app`."],
      [".env.example", "STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here"],
      ["docker-compose.yml", "      - API_TOKEN=${API_TOKEN}"],
    ];
    for (const [file, line] of code) expect([file, line, scan(line, file).map((f) => f.type)]).toEqual([file, line, []]);
  });

  test("the reported false positives stay quiet", () => {
    // From a Rust and TypeScript workspace that got 100 of these before the rule was fixed.
    const text = [
      "pub struct Window { pressed_keys: HashSet<KeyCode> }",
      "let pressed_keys = window.collect_pressed_keys();",
      "pub fn with_modifier_keys(keys: HashMap<KeyCode, Modifier>) -> Self { Self { keys } }",
      "let keyboard_state = KeyboardState::from_raw(raw);",
      "const secretSauce = computeSecretSauce(input);",
    ].join("\n");
    for (const file of ["apps/game/src/window.rs", "runtime/input/src/keys.rs", "io/apple/src/decode.rs", "src/index.ts"]) expect(scan(text, file)).toEqual([]);
  });

  test("real-shaped secrets are found in every common layout", () => {
    const v = fake(32);
    const layouts: [string, string | undefined][] = [
      [`API_KEY=${v}`, ".env"],
      [`export DB_PASSWORD='${v}'`, "deploy/env.sh"],
      [`SUPABASE_SERVICE_ROLE_KEY="${v}"`, ".env.production"],
      [`{ "client_secret": "${v}", "client_id": "app" }`, "config/oauth.json"],
      [`database:\n  password: ${v}\n`, "config/app.yaml"],
      [`[stripe]\nsecret_key = "${v}"\n`, "config.toml"],
      [`jwt.secret=${v}`, "application.properties"],
      [`ENV SENTRY_AUTH_TOKEN=${v}`, "Dockerfile"],
      [`const API_KEY: &str = "${v}";`, "src/main.rs"],
      [`api_key = "${v}"`, "app/settings.py"],
      [`apiKey := "${v}"`, "cmd/main.go"],
      [`private static final String CLIENT_SECRET = "${v}";`, "src/Main.java"],
      [`export const stripeKey = "${v}";`, "src/stripe.ts"],
      [`headers: { Authorization: "Bearer ${v}" },`, "src/client.ts"],
      [`password = "${v}"`, undefined],
    ];
    for (const [text, file] of layouts) expect([text, generic(text, file).length]).toEqual([text, 1]);
  });

  test("ranks by how sure it is", () => {
    const v = fake(40);
    expect(generic(`STRIPE_SECRET_KEY=${v}`, ".env")[0]!.confidence).toBe("high");
    expect(generic(`const apiKey = "${v}";`, "test/fixtures/client.test.ts")[0]!.confidence).not.toBe("high");
    expect(generic(`const apiKey = "${fake(64, "abcdef0123456789")}";`, "test/fixtures/client.test.ts")[0]!.confidence).toBe("low");
    // A bare `key` needs a value that can only be random.
    expect(generic(`key: "${fake(64, "abcdef0123456789")}"`, "src/a.ts")).toHaveLength(1);
    expect(generic(`key: "dashboard.settings.title"`, "src/a.ts")).toHaveLength(0);
  });

  test("provider keys are still found in code, and fakes in files aren't", () => {
    const ghp = "ghp" + "_" + fake(36);
    expect(scan(`const token = "${ghp}";`, "src/gh.ts").map((f) => f.type)).toEqual(["github-token"]);
    expect(scan(`token: "xoxb-` + `test-token-from-oauth"`, "test/x.test.ts")).toEqual([]);
    // Pasted in chat, a marked fake is still reported: the user asked about it.
    expect(scan("AKIA" + "IOSFODNN7EXAMPLE").map((f) => f.type)).toEqual(["aws-access-key"]);
  });

  test("chat redaction still hides made-up looking values", () => {
    const text = `password = "Correct-Horse-Battery-Staple-42"`;
    expect(scan(text, "test/a.test.ts")).toEqual([]);
    expect(shield(text).secrets.size).toBe(1);
  });
});
