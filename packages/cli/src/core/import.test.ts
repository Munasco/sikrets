import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Secret } from "./secret.ts";
import { detectFormat, fromManager, keyName, parseCsv, parseExport, type ImportEntry } from "./import.ts";
import { externalKeys } from "./keys.ts";

// Every value below is fake. Each fixture follows the real export's header and shape.

const reveal = (entries: ImportEntry[]) => Object.fromEntries(entries.map((e) => [e.key, e.value.reveal()]));

const APPLE = `Title,URL,Username,Password,Notes,OTPAuth
github.com (dev),https://github.com/,dev,fake-gh-pass,"line one
line two",otpauth://totp/GitHub:dev?secret=FAKESECRET
Bank,https://bank.example,me,"fake,with""quote",,
`;
const CHROME = `name,url,username,password,note
github.com,https://github.com/login,dev,fake-chrome-pass,
,https://www.example.org/,me,fake-example-pass,
`;
const FIREFOX = `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"
"https://accounts.example.com","me","fake-ff-pass",,"https://accounts.example.com","{guid-1}","1700000000000","1700000000000","1700000000000"
"https://accounts.example.com","me2","fake-ff-pass-2",,"https://accounts.example.com","{guid-2}","1700000000000","1700000000000","1700000000000"
`;
const BW_CSV = `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,login,AWS,,"access key: fake-akid
secret: fake-aws-secret",0,https://aws.amazon.com,root,fake-aws-pass,
,,note,Just a note,fake note body,,0,,,,
`;
const BW_JSON = JSON.stringify({
  encrypted: false,
  items: [
    { name: "Stripe", type: 1, login: { username: "ops", password: "fake-stripe-pass", totp: "FAKETOTP" }, fields: [{ name: "api key", value: "fake-sk", type: 1 }, { name: "region", value: "us", type: 0 }] },
    { name: "Note", type: 2, notes: "fake" },
  ],
});
const OP_CSV = `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes
Linear,https://linear.app,dev,fake-linear-pass,,false,false,,
`;
const ONEPUX = JSON.stringify({
  accounts: [
    {
      vaults: [
        {
          attrs: { name: "Private" },
          items: [
            {
              overview: { title: "Vercel", url: "https://vercel.com" },
              details: {
                loginFields: [{ designation: "username", value: "dev" }, { designation: "password", value: "fake-vercel-pass" }],
                sections: [{ fields: [{ title: "token", id: "t1", value: { concealed: "fake-vercel-token" } }, { title: "2fa", id: "o1", value: { totp: "otpauth://fake" } }, { title: "plain", id: "p1", value: { string: "not secret" } }] }],
              },
            },
            { overview: { title: "Wi-Fi" }, details: { password: "fake-wifi" } },
          ],
        },
      ],
    },
  ],
});
const DOTENV = `# comment
export OPENAI_API_KEY="sk-fake-123" # trailing comment
db_url=postgres://u:fake@host/db
EMPTY=
SINGLE='it''s raw'
MULTI="first
second"
ESCAPED="a\\nb"
not a line
`;

describe("detectFormat", () => {
  test.each([
    ["Passwords.csv", APPLE, "apple"],
    ["Chrome Passwords.csv", CHROME, "chrome"],
    ["logins.csv", FIREFOX, "firefox"],
    ["bitwarden.csv", BW_CSV, "bitwarden-csv"],
    ["bitwarden.json", BW_JSON, "bitwarden-json"],
    ["items.json", JSON.stringify([]), "bitwarden-json"],
    ["1password.csv", OP_CSV, "1password-csv"],
    ["export.data", ONEPUX, "1pux"],
    ["export.1pux", "", "1pux"],
    [".env", DOTENV, "dotenv"],
    ["bom.csv", `﻿${APPLE}`, "apple"],
  ] as const)("%s → %s", (file, text, format) => expect(detectFormat(file, text)).toBe(format));

  test("unknown shapes ask for --format", () => {
    expect(() => detectFormat("x.csv", "a,b,c\n1,2,3")).toThrow("--format");
    expect(() => detectFormat("x.json", '{"hello":1}')).toThrow("not a Bitwarden or 1Password export");
  });
});

describe("parsers", () => {
  test("CSV handles quotes, commas, doubled quotes and newlines inside fields", () => {
    expect(parseCsv('a,"b,c","d""e"\r\n"multi\nline",x,\n')).toEqual([["a", "b,c", 'd"e'], ["multi\nline", "x", ""]]);
  });

  test("Apple Passwords", () => {
    expect(reveal(parseExport("apple", APPLE))).toEqual({
      GITHUB_COM_DEV_USERNAME: "dev",
      GITHUB_COM_DEV_PASSWORD: "fake-gh-pass",
      GITHUB_COM_DEV_OTP: "otpauth://totp/GitHub:dev?secret=FAKESECRET",
      BANK_USERNAME: "me",
      BANK_PASSWORD: 'fake,with"quote',
    });
  });

  test("Chrome falls back to the host when a row has no name", () => {
    expect(reveal(parseExport("chrome", CHROME))).toEqual({
      GITHUB_COM_USERNAME: "dev",
      GITHUB_COM_PASSWORD: "fake-chrome-pass",
      EXAMPLE_ORG_USERNAME: "me",
      EXAMPLE_ORG_PASSWORD: "fake-example-pass",
    });
  });

  test("Firefox names by host and numbers duplicates", () => {
    expect(Object.keys(reveal(parseExport("firefox", FIREFOX)))).toEqual([
      "ACCOUNTS_EXAMPLE_COM_USERNAME",
      "ACCOUNTS_EXAMPLE_COM_PASSWORD",
      "ACCOUNTS_EXAMPLE_COM_USERNAME_2",
      "ACCOUNTS_EXAMPLE_COM_PASSWORD_2",
    ]);
  });

  test("Bitwarden CSV includes custom fields", () => {
    expect(reveal(parseExport("bitwarden-csv", BW_CSV))).toEqual({
      AWS_USERNAME: "root",
      AWS_PASSWORD: "fake-aws-pass",
      AWS_ACCESS_KEY: "fake-akid",
      AWS_SECRET: "fake-aws-secret",
    });
  });

  test("Bitwarden JSON includes hidden fields only, and refuses encrypted exports", () => {
    expect(reveal(parseExport("bitwarden-json", BW_JSON))).toEqual({
      STRIPE_USERNAME: "ops",
      STRIPE_PASSWORD: "fake-stripe-pass",
      STRIPE_OTP: "FAKETOTP",
      STRIPE_API_KEY: "fake-sk",
    });
    expect(() => parseExport("bitwarden-json", JSON.stringify({ encrypted: true, items: [] }))).toThrow("encrypted");
  });

  test("1Password CSV", () => {
    expect(reveal(parseExport("1password-csv", OP_CSV))).toEqual({ LINEAR_USERNAME: "dev", LINEAR_PASSWORD: "fake-linear-pass" });
  });

  test("1Password .1pux export.data", () => {
    expect(reveal(parseExport("1pux", ONEPUX))).toEqual({
      VERCEL_USERNAME: "dev",
      VERCEL_PASSWORD: "fake-vercel-pass",
      VERCEL_TOKEN: "fake-vercel-token",
      VERCEL_OTP: "otpauth://fake",
      WI_FI_PASSWORD: "fake-wifi",
    });
  });

  test(".env files", () => {
    expect(reveal(parseExport("dotenv", DOTENV))).toEqual({
      OPENAI_API_KEY: "sk-fake-123",
      DB_URL: "postgres://u:fake@host/db",
      SINGLE: "it''s raw",
      MULTI: "first\nsecond",
      ESCAPED: "a\nb",
    });
  });

  test("password manager listings keep their references", () => {
    const entries = fromManager([
      { item: "GitHub", field: "password", ref: "bw://1/password", value: Secret.of("fake-1") },
      { item: "GitHub", field: "password", ref: "bw://2/password", value: Secret.of("fake-2") },
    ]);
    expect(entries.map((e) => [e.key, e.ref])).toEqual([["GITHUB_PASSWORD", "bw://1/password"], ["GITHUB_PASSWORD_2", "bw://2/password"]]);
  });

  test("key names are always valid vault keys", () => {
    expect(keyName("1password.com", "password")).toBe("ITEM_1PASSWORD_COM_PASSWORD");
    expect(keyName("Café — prod", "api key")).toBe("CAF_PROD_API_KEY");
    for (const e of parseExport("apple", APPLE)) expect(e.key).toMatch(/^[A-Z][A-Z0-9_]{0,127}$/);
  });

  test("values are Secrets, so entries never print them", () => {
    const entries = parseExport("apple", APPLE);
    expect(JSON.stringify(entries)).not.toContain("fake-gh-pass");
    expect(Bun.inspect(entries)).not.toContain("fake-gh-pass");
  });
});

describe("sikrets import", () => {
  const keychain = new Map<string, string>();
  let root: string;
  let cwd: string;
  let output: string[];

  beforeEach(async () => {
    keychain.clear();
    output = [];
    root = await mkdtemp(path.join(os.tmpdir(), "sikrets-import-"));
    cwd = process.cwd();
    process.chdir(root);
    process.env.SIKRETS_VAULT = "keychain";
    spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
    spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
    spyOn(console, "error").mockImplementation((...a: unknown[]) => void output.push(a.join(" ")));
    spyOn(console, "log").mockImplementation((...a: unknown[]) => void output.push(a.join(" ")));
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  test("imports an Apple export by name only and says to delete the file", async () => {
    await Bun.write(path.join(root, "Passwords.csv"), APPLE);
    const { run } = await import("../commands/import.ts");
    await run(["Passwords.csv"], { yes: true });
    const service = `dev.sikrets.vault.${path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "")}`;
    expect(keychain.get(`${service}/GITHUB_COM_DEV_PASSWORD`)).toBe("fake-gh-pass");
    const text = output.join("\n");
    expect(text).toContain("+ GITHUB_COM_DEV_PASSWORD");
    expect(text).toContain("Delete it now: rm");
    for (const v of ["fake-gh-pass", 'fake,with"quote', "FAKESECRET"]) expect(text).not.toContain(v);
    expect((await externalKeys(root)).map((k) => k.key)).toContain("BANK_PASSWORD");
    expect(await Bun.file(path.join(root, ".sikrets/keys.json")).text()).not.toContain("fake-");
  });

  test("--dry-run writes nothing and a second import marks replacements", async () => {
    await Bun.write(path.join(root, ".env"), "API_KEY=fake-one\n");
    const { run } = await import("../commands/import.ts");
    await run([".env"], { "dry-run": true });
    expect(keychain.size).toBe(0);
    await run([".env"], { yes: true });
    output.length = 0;
    await run([".env"], { "dry-run": true, prefix: "legacy" });
    expect(output.join("\n")).toContain("+ LEGACY_API_KEY");
    await run([".env"], { "dry-run": true });
    expect(output.join("\n")).toContain("~ API_KEY  replaces the current value");
  });
});
