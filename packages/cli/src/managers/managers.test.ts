import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { externalKeys, saveExternalKeys, writeBack } from "../core/keys.ts";
import { Secret } from "../core/secret.ts";
import { bitwarden, parseRef as parseBwRef } from "./bitwarden.ts";
import { onepassword, parseRef as parseOpRef } from "./onepassword.ts";
import { managerFor } from "./index.ts";
import { openVault } from "../core/vault.ts";

// Vault values are stored sealed, so read them back the way the CLI does rather than off the raw keychain entry.
const opened = async (project: string, key: string) => (await (await openVault(project)).get(key))?.reveal();

// Fake `bw` and `op` on PATH (fakes/*.ts behind tiny shell wrappers), an in-memory keychain and a
// throwaway config dir, so no real vault, keychain or account is touched. Every value is fake.

const BW_PASSWORD = "fake-master-password";
const keychain = new Map<string, string>();
let dir: string;
let savedEnv: Record<string, string | undefined>;

const bwItems = () => [
  { id: "item-1", name: "GitHub", notes: null, login: { username: "dev", password: "old-github-token", totp: null }, fields: [{ name: "deploy key", value: "fake-deploy-key", type: 1 }, { name: "team", value: "core", type: 0 }] },
  { id: "item-2", name: "Notes only", notes: "fake note", fields: [] },
];
const opItems = () => [
  {
    id: "op-1",
    title: "Stripe",
    vault: { id: "v1", name: "Dev" },
    fields: [
      { id: "username", type: "STRING", label: "username", value: "acct" },
      { id: "credential", type: "CONCEALED", label: "credential", value: "fake-stripe-old" },
      { id: "s1f", type: "CONCEALED", label: "webhook", value: "fake-webhook", section: { id: "s1", label: "Hooks" } },
    ],
  },
];

async function fakeBin(name: string) {
  const file = path.join(dir, "bin", name);
  await Bun.write(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dir, "fakes", `${name}.ts`)}" "$@"\n`);
  await Bun.spawn(["chmod", "+x", file]).exited;
}
const calls = async () =>
  ((await Bun.file(path.join(dir, "calls.jsonl")).text().catch(() => "")) as string)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { bin: string; args: string[] });
const bwState = () => Bun.file(path.join(dir, "bw.json")).json();
const opState = () => Bun.file(path.join(dir, "op.json")).json();

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-pm-"));
  keychain.clear();
  savedEnv = { PATH: process.env.PATH, SIKRETS_CONFIG_DIR: process.env.SIKRETS_CONFIG_DIR, FAKE_PM_DIR: process.env.FAKE_PM_DIR, BW_SESSION: process.env.BW_SESSION, SIKRETS_BW: process.env.SIKRETS_BW, SIKRETS_OP: process.env.SIKRETS_OP, OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN };
  for (const k of ["BW_SESSION", "SIKRETS_BW", "SIKRETS_OP", "OP_SERVICE_ACCOUNT_TOKEN"]) delete process.env[k];
  await fakeBin("bw");
  await fakeBin("op");
  process.env.PATH = `${path.join(dir, "bin")}:${process.env.PATH}`;
  process.env.SIKRETS_CONFIG_DIR = path.join(dir, "config");
  process.env.FAKE_PM_DIR = dir;
  await Bun.write(path.join(dir, "bw.json"), JSON.stringify({ status: "unauthenticated", serverUrl: null, items: bwItems() }));
  await Bun.write(path.join(dir, "op.json"), JSON.stringify({ items: opItems() }));
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  await rm(dir, { recursive: true, force: true });
});

const unlockBw = (over: Partial<Parameters<typeof bitwarden.unlock>[0]> = {}) =>
  bitwarden.unlock({ server: "http://localhost:8222", email: "dev@example.com", password: async () => Secret.of(BW_PASSWORD), say: () => {}, ...over });

const unlockOp = () => onepassword.unlock({ password: async () => Secret.of("unused"), say: () => {} });

/** No secret value, password or session ever appears in any CLI's argv. */
async function expectCleanArgv(...values: string[]) {
  const argv = (await calls()).map((c) => c.args.join(" ")).join("\n");
  for (const v of [BW_PASSWORD, "fake-bw-session", "fake-op-session", ...values]) expect(argv).not.toContain(v);
}

describe("references", () => {
  test("Bitwarden refs default to the password field", () => {
    expect(parseBwRef("bw://item-1")).toEqual({ id: "item-1", field: "password" });
    expect(parseBwRef("bw://item-1/deploy key")).toEqual({ id: "item-1", field: "deploy key" });
    expect(() => parseBwRef("op://x/y/z")).toThrow("isn't a Bitwarden reference");
  });
  test("1Password refs take an optional section", () => {
    expect(parseOpRef("op://Dev/Stripe/credential")).toEqual({ vault: "Dev", item: "Stripe", field: "credential" });
    expect(parseOpRef("op://Dev/Stripe/Hooks/webhook")).toEqual({ vault: "Dev", item: "Stripe", section: "Hooks", field: "webhook" });
    expect(() => parseOpRef("op://Dev/Stripe")).toThrow("isn't a 1Password reference");
  });
  test("managerFor picks the adapter by scheme", () => {
    expect(managerFor("bw://a/password").id).toBe("bitwarden");
    expect(managerFor("op://a/b/c").id).toBe("1password");
    expect(() => managerFor("vault://x")).toThrow("isn't a password manager reference");
  });
});

describe("Bitwarden adapter", () => {
  test("a locked vault says how to unlock", async () => {
    await expect(bitwarden.read("bw://item-1/password")).rejects.toThrow("sikrets unlock bitwarden");
  });

  test("unlock points bw at the server, logs in and keeps the session in the keychain only", async () => {
    const said: string[] = [];
    expect(await unlockBw({ say: (m) => said.push(m) })).toBe("dev@example.com");
    expect(keychain.get("dev.sikrets.bitwarden/dev@example.com#session")).toBe("fake-bw-session");
    expect((await bwState()).serverUrl).toBe("http://localhost:8222");
    const connections = await Bun.file(path.join(dir, "config", "connections.json")).text();
    expect(connections).toContain('"bitwarden"');
    expect(connections).not.toContain("fake-bw-session");
    expect(said.join("\n")).not.toContain("fake-bw-session");
    await expectCleanArgv();
  });

  test("a wrong password fails without echoing it", async () => {
    const err = await unlockBw({ password: async () => Secret.of("wrong-fake-password") }).catch((e: Error) => e);
    expect(String(err)).toContain("bw login failed"); // bw printed its own reason to the terminal
    expect(String(err)).not.toContain("wrong-fake-password");
    expect(keychain.size).toBe(0);
  });

  test("switching servers while signed in is refused", async () => {
    await unlockBw();
    await expect(unlockBw({ server: "https://vault.example.com" })).rejects.toThrow("bw logout");
  });

  test("an already signed-in vault unlocks without --email", async () => {
    await unlockBw();
    const s = await bwState();
    await Bun.write(path.join(dir, "bw.json"), JSON.stringify({ ...s, status: "locked" }));
    expect(await unlockBw({ email: undefined, server: undefined })).toBe("dev@example.com");
    expect((await calls()).some((c) => c.args[0] === "unlock")).toBe(true);
  });

  test("read returns login and custom fields as Secrets", async () => {
    await unlockBw();
    const pw = await bitwarden.read("bw://item-1/password");
    expect(pw).toBeInstanceOf(Secret);
    expect(pw.reveal()).toBe("old-github-token");
    expect((await bitwarden.read("bw://item-1/deploy key")).reveal()).toBe("fake-deploy-key");
    expect((await bitwarden.read("bw://item-2/notes")).reveal()).toBe("fake note");
    await expect(bitwarden.read("bw://item-2/password")).rejects.toThrow('"Notes only" has no password');
  });

  test("write edits the item through stdin, never argv", async () => {
    await unlockBw();
    await bitwarden.write("bw://item-1/password", Secret.of("new-github-token"));
    await bitwarden.write("bw://item-1/api key", Secret.of("new-custom-field"));
    const item = (await bwState()).items[0];
    expect(item.login.password).toBe("new-github-token");
    expect(item.fields).toContainEqual({ name: "api key", value: "new-custom-field", type: 1 });
    expect(item.fields).toContainEqual({ name: "team", value: "core", type: 0 }); // untouched
    await expectCleanArgv("new-github-token", "new-custom-field");
    await expect(bitwarden.write("bw://item-2/password", Secret.of("x-fake"))).rejects.toThrow("isn't a login item");
  });

  test("list returns passwords and hidden fields, not plain text fields", async () => {
    await unlockBw();
    const entries = await bitwarden.list();
    expect(entries.map((e) => [e.ref, e.item, e.field])).toEqual([
      ["bw://item-1/password", "GitHub", "password"],
      ["bw://item-1/deploy key", "GitHub", "deploy key"],
    ]);
    expect(JSON.stringify(entries)).not.toContain("old-github-token");
  });

  test("lock forgets the session", async () => {
    await unlockBw();
    await bitwarden.lock();
    expect(keychain.size).toBe(0);
    await expect(bitwarden.read("bw://item-1")).rejects.toThrow("locked");
  });

  test("a BW_SESSION already in the environment is used as is", async () => {
    process.env.BW_SESSION = "fake-bw-session";
    expect((await bitwarden.read("bw://item-1")).reveal()).toBe("old-github-token");
  });

  test("a missing CLI says how to install it", async () => {
    process.env.BW_SESSION = "fake-bw-session";
    process.env.SIKRETS_BW = "definitely-not-bw";
    await expect(bitwarden.read("bw://item-1")).rejects.toThrow("isn't installed");
  });
});

describe("1Password adapter", () => {

  test("unlock keeps the session token in the keychain", async () => {
    expect(await unlockOp()).toBe("dev@example.com");
    expect(keychain.get("dev.sikrets.1password/FAKEUSERUUID#session")).toBe("fake-op-session");
  });

  test("read uses op references", async () => {
    await unlockOp();
    expect((await onepassword.read("op://Dev/Stripe/credential")).reveal()).toBe("fake-stripe-old");
    await expect(onepassword.read("op://Dev/Missing/credential")).rejects.toThrow("isn't an item");
  });

  test("not signed in fails with op's message", async () => {
    await expect(onepassword.read("op://Dev/Stripe/credential")).rejects.toThrow("not currently signed in");
  });

  test("write edits the field through a template on stdin", async () => {
    await unlockOp();
    await onepassword.write("op://Dev/Stripe/credential", Secret.of("fake-stripe-new"));
    await onepassword.write("op://Dev/Stripe/Hooks/webhook", Secret.of("fake-webhook-new"));
    const fields = (await opState()).items[0].fields;
    expect(fields.find((f: { id: string }) => f.id === "credential").value).toBe("fake-stripe-new");
    expect(fields.find((f: { id: string }) => f.id === "s1f").value).toBe("fake-webhook-new");
    expect(fields.find((f: { id: string }) => f.id === "username").value).toBe("acct");
    await expectCleanArgv("fake-stripe-new", "fake-webhook-new");
    await expect(onepassword.write("op://Dev/Stripe/nope", Secret.of("x-fake"))).rejects.toThrow('no field "nope"');
  });

  test("list returns concealed fields with their references", async () => {
    await unlockOp();
    const entries = await onepassword.list();
    expect(entries.map((e) => [e.ref, e.item, e.field])).toEqual([
      ["op://Dev/Stripe/credential", "Stripe", "credential"],
      ["op://Dev/Stripe/Hooks/webhook", "Stripe", "webhook"],
    ]);
  });

  test("a service account token skips sign-in", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_fake";
    expect(await unlockOp()).toBe("service-account");
    expect(keychain.size).toBe(0);
  });
});

describe("rotation write-back", () => {
  test("linked keys get the new value; unlinked keys and failures don't stop the rest", async () => {
    await unlockBw();
    await unlockOp();
    const root = path.join(dir, "project");
    await saveExternalKeys(root, [
      { key: "GITHUB_TOKEN", source: "bitwarden", ref: "bw://item-1/password", addedAt: "2026-01-01T00:00:00Z" },
      { key: "STRIPE_KEY", source: "1password", ref: "op://Dev/Stripe/credential", addedAt: "2026-01-01T00:00:00Z" },
      { key: "GONE", source: "bitwarden", ref: "bw://missing/password", addedAt: "2026-01-01T00:00:00Z" },
      { key: "PLAIN", source: ".env file", addedAt: "2026-01-01T00:00:00Z" },
    ]);
    const said: string[] = [];
    const values = new Map([
      ["GITHUB_TOKEN", Secret.of("rotated-github")],
      ["STRIPE_KEY", Secret.of("rotated-stripe")],
      ["GONE", Secret.of("rotated-gone")],
      ["PLAIN", Secret.of("rotated-plain")],
    ]);
    const result = await writeBack(root, values, (m) => said.push(m));
    expect(result.map((r) => [r.key, Boolean(r.error)])).toEqual([["GITHUB_TOKEN", false], ["GONE", true], ["STRIPE_KEY", false]]);
    expect((await bwState()).items[0].login.password).toBe("rotated-github");
    expect((await opState()).items[0].fields[1].value).toBe("rotated-stripe");
    expect(said.join("\n")).not.toMatch(/rotated-/);
    await expectCleanArgv("rotated-github", "rotated-stripe", "rotated-gone");
  });
});

describe("sikrets import/link with a password manager", () => {
  test("import bitwarden links every key; link copies one item; output never shows values", async () => {
    await unlockBw();
    await unlockOp();
    const root = path.join(dir, "project");
    await Bun.write(path.join(root, ".keep"), "");
    const cwd = process.cwd();
    const output: string[] = [];
    spyOn(console, "error").mockImplementation((...a: unknown[]) => void output.push(a.join(" ")));
    spyOn(console, "log").mockImplementation((...a: unknown[]) => void output.push(a.join(" ")));
    process.chdir(root);
    try {
      await (await import("../commands/import.ts")).run(["bitwarden"], { yes: true });
      await (await import("../commands/link.ts")).run(["STRIPE_KEY", "op://Dev/Stripe/credential"], {});
    } finally {
      process.chdir(cwd);
    }
    expect(await opened("project", "GITHUB_PASSWORD")).toBe("old-github-token");
    expect(await opened("project", "STRIPE_KEY")).toBe("fake-stripe-old");
    expect((await externalKeys(root)).map((k) => [k.key, k.ref])).toEqual([
      ["GITHUB_DEPLOY_KEY", "bw://item-1/deploy key"],
      ["GITHUB_PASSWORD", "bw://item-1/password"],
      ["STRIPE_KEY", "op://Dev/Stripe/credential"],
    ]);
    const text = output.join("\n");
    expect(text).toContain("Linked to Bitwarden");
    expect(text).not.toContain("Delete it now"); // nothing on disk to delete
    for (const v of ["old-github-token", "fake-deploy-key", "fake-stripe-old", "fake-bw-session"]) expect(text).not.toContain(v);
  });
});
