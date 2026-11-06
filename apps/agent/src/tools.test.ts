import { describe, expect, test } from "bun:test";
import { Vault } from "./redact.ts";
import { redact, scan, sha256 } from "./patterns.ts";
import { checkLeakHashes, howToRotate, osvLookup, scanGithubRepo, scanText, untar } from "./tools.ts";

// Fake values shaped like real keys, assembled at runtime so no scanner mistakes this file for a leak.
const FAKE = {
  github: "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  stripe: "sk" + "_live_" + "51Hx9fakeFAKEfake0123456789abcdef",
  aws: "AKIA" + "QWERTYUIOPASDFGH",
  resend: "re" + "_Ab12Cd34_" + "EfGh56IjKl78MnOp90",
};

describe("scan", () => {
  test("finds provider keys with their lines and never returns the value", async () => {
    const text = `const a = 1;\nGITHUB_TOKEN=${FAKE.github}\nstripe.key = "${FAKE.stripe}"\naws_access_key_id = ${FAKE.aws}\nRESEND=${FAKE.resend}`;
    const { findings } = await scanText({ text });
    const types = findings.map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(["github-token", "stripe-key", "aws-access-key", "resend-key"]));
    expect(findings.find((f) => f.type === "github-token")!.line).toBe(2);
    const out = JSON.stringify(findings);
    for (const v of Object.values(FAKE)) expect(out).not.toContain(v);
    expect(findings.find((f) => f.type === "stripe-key")!.sha256).toBe(sha256(FAKE.stripe));
  });

  test("redacts to a prefix and the last four characters", () => {
    expect(redact(FAKE.stripe)).toBe("sk_live_…cdef");
    expect(redact(FAKE.github)).toBe("ghp_…q7R8");
  });

  test("skips placeholders and low-entropy values", () => {
    expect(scan(`api_key = "your-api-key-goes-here"\ntoken: "xxxxxxxxxxxxxxxxxxxxxxxx"\npassword = "aaaaaaaaaaaaaaaaaaaa"`)).toHaveLength(0);
    expect(scan(`client_secret = "q8F3kZ0pL1mV7wX2yR9tB4nC6"`)).toHaveLength(1);
    expect(scan(`apiKeys: "https://console.upstash.com/account/api",\ntokenPath: "/v1/oauth/token/refresh"`)).toHaveLength(0);
  });

  test("catches prefixed names and unquoted .env values", () => {
    const v = "q8F3kZ0pL1mV7wX2yR9tB4nC6dE1fG2h";
    expect(scan(`SUPABASE_KEY="${v}"`)).toHaveLength(1);
    expect(scan(`DB_PASSWORD=${v}`)).toHaveLength(1);
    expect(scan(`export MY_AUTH_TOKEN=${v}`)).toHaveLength(1);
    expect(scan(`NEXT_PUBLIC_API_URL=https://api.example.com/v1/items`)).toHaveLength(0);
  });

  test("hides a private key's body", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----";
    const [f] = scan(pem);
    expect(f!.redacted).not.toContain("secretbody");
  });
});

describe("vault", () => {
  test("the model sees placeholders and tools get the real values back", () => {
    const vault = new Vault();
    const { text, hidden } = vault.shield("s1", `my key is ${FAKE.stripe} help`);
    expect(hidden).toBe(1);
    expect(text).not.toContain(FAKE.stripe);
    expect(text).toContain("sk_live_…cdef");
    expect(vault.reveal("s1", { text })).toEqual({ text: `my key is ${FAKE.stripe} help` });
    // Another session's placeholders don't resolve.
    expect(vault.reveal("s2", { text })).toEqual({ text });
  });

  test("redacts bare high-entropy tokens in chat, but not prose or placeholders", () => {
    const vault = new Vault();
    const hex = "a3f9c2e17b4d8e0f6a1c9b2d4e7f8a0c";
    const b64 = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg";
    const r = vault.shield("s1", `is this leaked? ${hex} and ${b64}`);
    expect(r.hidden).toBe(2);
    expect(r.text).not.toContain(hex);
    expect(r.text).not.toContain(b64);
    expect(vault.reveal("s1", { t: r.text })).toEqual({ t: `is this leaked? ${hex} and ${b64}` });
    const prose = "Please rotate the production credentials before the deployment window closes tonight";
    expect(vault.shield("s1", prose).hidden).toBe(0);
    expect(vault.shield("s1", "https://github.com/Munasco/sikrets/blob/main/packages/cli/src/index.ts").hidden).toBe(0);
    expect(vault.shield("s1", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").hidden).toBe(0);
  });

  test("leaves provider metadata alone: Gemini rejects a redacted thought signature", () => {
    const vault = new Vault();
    const signature = "ErcBCrQBAWkUfRNLJBHnWqsJgS7hyN3U78QMKiTrgoGegs1XNwe1vYwebIOEjcBHYSd8SeUrrP34U4GnRflJX2FTSzxR5X8rtWKzrq6dm0ioIqDhwJB7laA=";
    const messages = [{ role: "assistant", content: [{ type: "tool-call", name: "scan_text", native: { thoughtSignature: signature } }, { type: "text", text: `token ${FAKE.github}` }] }];
    vault.shieldAll("s1", messages);
    expect(messages[0]!.content[0]!.native!.thoughtSignature).toBe(signature);
    expect(JSON.stringify(messages)).not.toContain(FAKE.github);
  });

  test("redacts nested request content and spots leaks, raw or JSON-escaped", () => {
    const vault = new Vault();
    const messages = [{ role: "user", content: [{ type: "text", text: `GITHUB_TOKEN=${FAKE.github}` }] }];
    vault.shieldAll("s1", messages);
    expect(JSON.stringify(messages)).not.toContain(FAKE.github);
    expect(vault.leaks(JSON.stringify(messages))).toBe(false);
    expect(vault.leaks(`{"text":"${FAKE.github}"}`)).toBe(true);
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsecretbody\n-----END RSA PRIVATE KEY-----";
    vault.shield("s1", pem);
    expect(vault.leaks(JSON.stringify({ text: pem }))).toBe(true);
  });
});

describe("check_leak_hashes", () => {
  test("matches known hashes without needing the keys", async () => {
    const r = await checkLeakHashes({ hashes: [sha256(FAKE.resend), "0".repeat(64)], text: `RESEND_API_KEY=${FAKE.resend}\nother=thing` });
    expect(r).toMatchObject({ hashes: 2, matched: 1 });
    expect(JSON.stringify(r)).not.toContain(FAKE.resend);
  });
});

describe("untar", () => {
  test("reads files from a tarball with a pax header", () => {
    const block = (name: string, body: string, type = "0") => {
      const h = new Uint8Array(512);
      const put = (s: string, o: number) => h.set(new TextEncoder().encode(s), o);
      put(name, 0);
      put(body.length.toString(8).padStart(11, "0"), 124);
      put(type, 156);
      const data = new Uint8Array(Math.ceil(body.length / 512) * 512);
      data.set(new TextEncoder().encode(body));
      return [h, data];
    };
    const parts = [...block("pax_global_header", "52 comment=abc\n", "g"), ...block("repo-abc/.env", `TOKEN=${FAKE.github}\n`), new Uint8Array(1024)];
    const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (tar.set(p, o), (o += p.length));
    const files = untar(tar);
    expect(files.map((f) => f.path)).toEqual(["repo-abc/.env"]);
  });
});

describe("how_to_rotate", () => {
  test("gives the rotation page, env vars and Sikrets commands", () => {
    const r = howToRotate({ service: "Stripe" }) as { results: Array<{ id: string; rotateAt: string; envVars: string[]; sikrets: string[] }> };
    expect(r.results[0]).toMatchObject({ id: "stripe", rotateAt: "https://dashboard.stripe.com/apikeys" });
    expect(r.results[0]!.sikrets[0]).toBe("sikrets proxy add stripe");
  });
  test("unknown services say so", () => {
    expect(howToRotate({ service: "definitely-not-a-service-xyz" })).toHaveProperty("error");
  });
});

// Network: real GitHub and OSV.
describe("live", () => {
  test("scans a public repo", async () => {
    const r = (await scanGithubRepo({ repo: "github.com/octocat/Hello-World" })) as { filesScanned: number; count: number };
    expect(r.filesScanned).toBeGreaterThan(0);
    expect(r.count).toBe(0);
  });
  test("private or missing repos explain themselves", async () => {
    expect(await scanGithubRepo({ repo: "octocat/definitely-missing-repo-xyz" })).toHaveProperty("error");
  });
  test("finds known vulnerabilities", async () => {
    const r = (await osvLookup({ name: "lodash", version: "4.17.15", ecosystem: "npm" })) as { count: number; vulns: Array<{ id: string }> };
    expect(r.count).toBeGreaterThan(0);
  });
});
