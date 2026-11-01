import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorize, listGrants, revokeGrants, type Decision } from "./core/logins/grants.ts";
import { loginOrigin, sameOrigin } from "./core/logins/origin.ts";
import { hotp, parseTotp, totpCode } from "./core/logins/totp.ts";
import { Secret } from "./core/secret.ts";
import { ENV } from "./constants.ts";

const base32 = (bytes: Uint8Array) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return bits.match(/.{1,5}/g)!.map((c) => A[parseInt(c.padEnd(5, "0"), 2)]).join("");
};

describe("origin matching", () => {
  test("stores the origin only, normalized", () => {
    expect(loginOrigin("https://GitHub.com/login?x=1")).toBe("https://github.com");
    expect(loginOrigin("github.com")).toBe("https://github.com");
    expect(loginOrigin("https://example.com:443/")).toBe("https://example.com");
    expect(loginOrigin("http://127.0.0.1:8080/login")).toBe("http://127.0.0.1:8080");
  });

  test("refuses http (except local servers), other schemes and URLs with credentials", () => {
    expect(() => loginOrigin("http://example.com")).toThrow("isn't https");
    expect(() => loginOrigin("ftp://example.com")).toThrow();
    expect(() => loginOrigin("javascript:alert(1)")).toThrow();
    expect(() => loginOrigin("https://user:pw@example.com")).toThrow("username or password");
  });

  test("exact origin matches, any path", () => {
    expect(sameOrigin("https://example.com/login", "https://example.com")).toBe(true);
    expect(sameOrigin("https://EXAMPLE.com:443/a?b#c", "https://example.com")).toBe(true);
  });

  test("subdomains and parent domains don't match", () => {
    expect(sameOrigin("https://login.example.com/", "https://example.com")).toBe(false);
    expect(sameOrigin("https://example.com/", "https://login.example.com")).toBe(false);
    expect(sameOrigin("https://example.com.evil.net/", "https://example.com")).toBe(false);
  });

  test("http vs https and other ports don't match", () => {
    expect(sameOrigin("http://example.com/", "https://example.com")).toBe(false);
    expect(sameOrigin("https://example.com:8443/", "https://example.com")).toBe(false);
  });

  test("punycode: a Unicode lookalike never matches the ASCII name, the same IDN does", () => {
    // "exаmple.com" with a Cyrillic а (U+0430).
    expect(sameOrigin("https://exаmple.com/", "https://example.com")).toBe(false);
    expect(new URL("https://exаmple.com/").hostname).toStartWith("xn--");
    expect(sameOrigin("https://xn--bcher-kva.example/", loginOrigin("https://bücher.example"))).toBe(true);
  });

  test("lookalikes and tricks don't match", () => {
    expect(sameOrigin("https://examp1e.com/", "https://example.com")).toBe(false);
    expect(sameOrigin("https://example.com@evil.com/", "https://example.com")).toBe(false);
    expect(sameOrigin("https://evil.com/?next=https://example.com", "https://example.com")).toBe(false);
    expect(sameOrigin("https://example.com./", "https://example.com")).toBe(false);
    expect(sameOrigin("about:blank", "https://example.com")).toBe(false);
    expect(sameOrigin("data:text/html,<form>", "https://example.com")).toBe(false);
    expect(sameOrigin("not a url", "https://example.com")).toBe(false);
  });
});

describe("TOTP", () => {
  // RFC 6238 appendix B: the seeds are the ASCII digits repeated to the hash's key size.
  const seeds = {
    SHA1: "12345678901234567890",
    SHA256: "12345678901234567890123456789012",
    SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
  } as const;
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];

  test("RFC 4226 HOTP vectors", () => {
    const key = new TextEncoder().encode(seeds.SHA1);
    expect([0, 1, 2, 9].map((c) => hotp(key, c, 6, "SHA1"))).toEqual(["755224", "287082", "359152", "520489"]);
  });

  test("RFC 6238 vectors for SHA1, SHA256 and SHA512, via otpauth:// URIs", () => {
    for (const [i, algorithm] of (["SHA1", "SHA256", "SHA512"] as const).entries()) {
      const uri = `otpauth://totp/Test:fake@example.com?secret=${base32(new TextEncoder().encode(seeds[algorithm]))}&algorithm=${algorithm}&digits=8&period=30&issuer=Test`;
      const config = parseTotp(Secret.of(uri));
      for (const v of vectors) expect(totpCode(config, v[0] * 1000).reveal()).toBe(String(v[i + 1]));
    }
  });

  test("a bare base32 secret uses the defaults (SHA1, 6 digits, 30s)", () => {
    const config = parseTotp(Secret.of(base32(new TextEncoder().encode(seeds.SHA1)).toLowerCase()));
    expect(config).toMatchObject({ digits: 6, period: 30, algorithm: "SHA1" });
    expect(totpCode(config, 59_000).reveal()).toBe("287082");
  });

  test("bad secrets fail without quoting them, and codes are masked", () => {
    const err = (() => {
      try {
        parseTotp(Secret.of("otpauth://hotp/x?secret=FAKESECRETVALUE"));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain("FAKESECRETVALUE");
    expect(() => parseTotp(Secret.of("not!base32"))).toThrow("base32");
    expect(String(totpCode(parseTotp(Secret.of("JBSWY3DPEHPK3PXP"))))).not.toMatch(/\d{6}/);
  });
});

describe("grants", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-grants-"));
    Bun.env[ENV.configDir] = dir;
  });
  afterEach(async () => {
    delete Bun.env[ENV.configDir];
    await rm(dir, { recursive: true, force: true });
  });

  const approver = (decision: Decision) => {
    const asked: string[] = [];
    return { asked, approve: async (r: { agent: string }) => (asked.push(r.agent), decision) };
  };

  test("allow once lets this call through but asks again next time", async () => {
    const a = approver("once");
    expect(await authorize("github", "https://github.com", "claude-code", a.approve)).toEqual({ allowed: true, asked: true });
    expect(await authorize("github", "https://github.com", "claude-code", a.approve)).toEqual({ allowed: true, asked: true });
    expect(a.asked).toHaveLength(2);
    expect(await listGrants()).toEqual([]);
  });

  test("allow for this agent is remembered for that agent and login only", async () => {
    const a = approver("always");
    await authorize("github", "https://github.com", "claude-code", a.approve);
    expect(await authorize("github", "https://github.com", "claude-code", a.approve)).toEqual({ allowed: true, asked: false });
    await authorize("github", "https://github.com", "codex", a.approve);
    await authorize("gitlab", "https://gitlab.com", "claude-code", a.approve);
    expect(a.asked).toEqual(["claude-code", "codex", "claude-code"]);
  });

  test("deny refuses and remembers nothing; an approver that fails counts as deny", async () => {
    expect(await authorize("github", "https://github.com", "claude-code", approver("deny").approve)).toEqual({ allowed: false, asked: true });
    expect(await authorize("github", "https://github.com", "claude-code", async () => Promise.reject(new Error("no display")))).toMatchObject({ allowed: false });
    expect(await listGrants()).toEqual([]);
  });

  test("revoke one agent, or every agent; revoked agents are asked again", async () => {
    const a = approver("always");
    for (const agent of ["claude-code", "codex", "cursor"]) await authorize("github", "https://github.com", agent, a.approve);
    expect(await revokeGrants("github", "codex")).toBe(1);
    expect((await listGrants()).map((g) => g.agent)).toEqual(["claude-code", "cursor"]);
    await authorize("github", "https://github.com", "codex", a.approve);
    expect(a.asked.at(-1)).toBe("codex");
    expect(await revokeGrants("github")).toBe(3);
    expect(await listGrants()).toEqual([]);
  });
});
