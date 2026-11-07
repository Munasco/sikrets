import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readActivity } from "./core/activity.ts";
import { clipboard } from "./core/clipboard.ts";
import { ensureDataKey, loadDataKey } from "./core/datakey.ts";
import { resetDevice } from "./core/device.ts";
import { native } from "./core/doorman.ts";
import { envelopeKind, openValue, projectKey, sealValue } from "./core/envelope.ts";
import { Secret } from "./core/secret.ts";
import { standInKey } from "./core/standin.ts";
import { state, type Resource } from "./core/state.ts";
import { openVault } from "./core/vault.ts";
import { DEFAULT_USER } from "./testing/device-server.ts";
import { TEST_SERVER, testServer } from "./testing/preload.ts";
import { ENVELOPE, REVEAL, SERVER } from "./constants.ts";

// Client-side encryption in the vault, and the Touch ID gate in front of anything that reveals a
// real value. The vault is the real server, in memory (see testing/preload.ts); the keychain is in
// memory, the authenticator and clipboard are faked, and every value is fake and assembled at
// runtime. Command output is captured, never printed.

const keychain = new Map<string, string>();
let root: string;
let home: string;
let cwd: string;
let out: string[];

const REAL = ["tok", "live", "fakefakefakefakefake"].join("_");

beforeEach(async () => {
  keychain.clear();
  out = [];
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-seal-"));
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-seal-home-"));
  process.env.SIKRETS_CONFIG_DIR = home;
  await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo" }));
  cwd = process.cwd();
  process.chdir(root);
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  spyOn(process.stdout, "write").mockImplementation(((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write);
});

afterEach(async () => {
  mock.restore();
  process.chdir(cwd);
  delete process.env.SIKRETS_CONFIG_DIR;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** Exactly what the server holds for a key. */
const scope = (project: string) => ({ account: DEFAULT_USER, project, environment: SERVER.environment });
const raw = async (project: string, key: string) => (await testServer().store.getValue(scope(project), key))?.value;
const printed = () => out.join("\n");
const command = async (name: string) => (await import(`./commands/${name}.ts`)) as { run: (args: string[], opts: Record<string, unknown>) => Promise<void> };
const authAs = (ok: boolean) =>
  spyOn(native, "authenticate").mockImplementation(async () => (ok ? { ok: true } : { ok: false, reason: "Not authenticated, so the real value stays hidden" }));

/** An applied resource whose secret is in the vault. */
async function stored(value: string, over: Partial<Resource> = {}) {
  const res: Resource = { name: "anthropic", recipe: "anthropic/api-key", provider: "anthropic", strategy: "manual", inputs: {}, dependsOn: {}, envKeys: ["ANTHROPIC_API_KEY"], outputs: {}, applied: true, createdAt: new Date().toISOString(), ...over };
  await state.upsert(root, res);
  await (await openVault("demo")).put("ANTHROPIC_API_KEY", Secret.of(value));
  return "ANTHROPIC_API_KEY";
}

describe("envelope", () => {
  test("seal/open round trip, bound to project and key name", async () => {
    const key = projectKey(await ensureDataKey(), "demo");
    const sealed = sealValue(key, "demo", "API_KEY", REAL);
    expect(sealed.startsWith(ENVELOPE.prefix)).toBe(true);
    expect(sealed).not.toContain(REAL);
    expect(envelopeKind(sealed)).toBe("sealed");
    expect(openValue(key, "demo", "API_KEY", sealed)).toBe(REAL);
    // Fresh IV every time: the same value never seals to the same string.
    expect(sealValue(key, "demo", "API_KEY", REAL)).not.toBe(sealed);
  });

  test("a ciphertext moved to another key name or project doesn't open", async () => {
    const dataKey = await ensureDataKey();
    const sealed = sealValue(projectKey(dataKey, "demo"), "demo", "API_KEY", REAL);
    expect(() => openValue(projectKey(dataKey, "demo"), "demo", "OTHER_KEY", sealed)).toThrow("Can't decrypt OTHER_KEY");
    expect(() => openValue(projectKey(dataKey, "shop"), "shop", "API_KEY", sealed)).toThrow("Can't decrypt");
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => openValue(projectKey(dataKey, "demo"), "demo", "API_KEY", tampered)).toThrow("Can't decrypt");
    expect(() => openValue(projectKey(dataKey, "demo"), "demo", "API_KEY", "sk9:abcd")).toThrow("newer Sikrets");
  });

  test("the SDK opens what the CLI seals", async () => {
    await (await openVault("demo")).put("API_KEY", Secret.of(REAL));
    // The SDK doesn't read the server yet; hand it the envelope through its keychain backend.
    keychain.set(`dev.sikrets.vault.demo/API_KEY`, (await raw("demo", "API_KEY"))!);
    const { createSikrets } = await import("../../sdk/src/index.ts");
    expect(await createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("API_KEY")).toBe(REAL);
  });

  test("swapping two values in the vault is caught on read", async () => {
    const vault = await openVault("demo");
    await vault.put("A_KEY", Secret.of(REAL));
    await vault.put("B_KEY", Secret.of(`${REAL}_b`));
    // The server swaps them (it can: it holds only ciphertext). The client notices.
    const b = (await testServer().store.getValue(scope("demo"), "B_KEY"))!;
    await testServer().store.putValue(scope("demo"), { ...b, name: "A_KEY" });
    await expect(vault.get("A_KEY")).rejects.toThrow("Can't decrypt A_KEY");
  });
});

describe("sealed vault", () => {
  test("the server holds only the envelope; the value reads back here", async () => {
    const vault = await openVault("demo");
    expect(vault.server).toBe(TEST_SERVER);
    await vault.put("API_KEY", Secret.of(REAL));
    expect(envelopeKind((await raw("demo", "API_KEY"))!)).toBe("sealed");
    expect(await raw("demo", "API_KEY")).not.toContain(REAL);
    expect((await vault.get("API_KEY"))?.reveal()).toBe(REAL);
    expect(await vault.has("API_KEY")).toBe(true);
    expect(await vault.list()).toEqual(["API_KEY"]);
    expect(await vault.get("OTHER_KEY")).toBeUndefined();
    await vault.delete("API_KEY");
    expect([await vault.has("API_KEY"), await raw("demo", "API_KEY")]).toEqual([false, undefined]);
  });

  test("the first write creates the data key; a device without it can't read sealed values", async () => {
    expect(await loadDataKey()).toBeUndefined();
    await (await openVault("demo")).put("API_KEY", Secret.of(REAL));
    expect(await loadDataKey()).toBeDefined();
    await resetDevice(); // a new device on the same account: no device keys, no wrapped data key
    const vault = await openVault("demo");
    await expect(vault.get("API_KEY")).rejects.toThrow("sikrets recovery restore");
    // Nor does it mint a fresh key next to sealed values it can't open.
    await expect(vault.put("OTHER_KEY", Secret.of(REAL))).rejects.toThrow("sikrets recovery restore");
    expect(await loadDataKey()).toBeUndefined();
  });

  test("normal values fit; oversize ones fail clearly and aren't stored", async () => {
    const vault = await openVault("demo");
    await vault.put("PRIVATE_KEY", Secret.of("x".repeat(3000))); // about the size of a 2048-bit private key
    await expect(vault.put("HUGE_KEY", Secret.of("x".repeat(70_000)))).rejects.toThrow("HUGE_KEY is too large to store once encrypted");
    expect(await vault.list()).toEqual(["PRIVATE_KEY"]);
  });

  test("a sealed value is uploaded as is; plaintext never is", async () => {
    const sealed = sealValue(projectKey(await ensureDataKey(), "demo"), "demo", "API_KEY", REAL);
    const vault = await openVault("demo");
    await vault.putSealed("API_KEY", sealed);
    expect(await raw("demo", "API_KEY")).toBe(sealed);
    expect((await vault.get("API_KEY"))?.reveal()).toBe(REAL);
    await expect(vault.putSealed("OTHER_KEY", REAL)).rejects.toThrow("isn't sealed");
  });
});

describe("sikrets get", () => {
  test("default output is the stand-in, never the real value", async () => {
    const key = await stored(REAL);
    const ask = authAs(true);
    await (await command("get")).run([key], {});
    const standIn = (await (await openVault("demo")).get(standInKey(key)))!.reveal();
    expect(out).toEqual([standIn]);
    expect(printed()).not.toContain(REAL);
    expect(ask).not.toHaveBeenCalled();
    // Stable: asking again prints the same stand-in.
    out.length = 0;
    await (await command("get")).run([key], { json: true });
    const json = JSON.parse(out[0]!);
    expect(json).toMatchObject({ key, standIn, project: "demo", server: TEST_SERVER, set: true, resource: "anthropic" });
    expect(printed()).not.toContain(REAL);
  });

  test("a key without a stand-in yet (imported) gets one, persisted", async () => {
    await (await openVault("demo")).put("IMPORTED_TOKEN", Secret.of(REAL));
    await (await command("get")).run(["IMPORTED_TOKEN"], {});
    expect(out[0]).toMatch(/^sk-sikrets-[A-Za-z0-9]{32}$/);
    expect(await raw("demo", standInKey("IMPORTED_TOKEN"))).toBeDefined();
    expect(printed()).not.toContain(REAL);
  });

  test("--real and --copy refuse when authentication is denied or unavailable", async () => {
    const key = await stored(REAL);
    const copy = spyOn(clipboard, "copy").mockImplementation(async () => {});
    const clear = spyOn(clipboard, "clearLater").mockImplementation(() => {});
    authAs(false);
    for (const opts of [{ real: true }, { copy: true }]) await expect((await command("get")).run([key], opts)).rejects.toThrow("stays hidden");
    expect(copy).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(printed()).not.toContain(REAL);
    expect((await readActivity(root)).filter((a) => a.kind === "reveal")).toHaveLength(0);
  });

  test("no system dialog in CI: the real authenticator refuses without prompting", async () => {
    process.env[REVEAL.ciEnv] = "1";
    try {
      const check = await native.authenticate("show the real value of ANTHROPIC_API_KEY");
      expect(check.ok).toBe(false);
    } finally {
      delete process.env[REVEAL.ciEnv];
    }
  });

  test("--real prints the value after authenticating, and the reveal is logged by name", async () => {
    const key = await stored(REAL);
    const ask = authAs(true);
    await (await command("get")).run([key], { real: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out).toEqual([`${REAL}\n`]);
    const reveals = (await readActivity(root)).filter((a) => a.kind === "reveal");
    expect(reveals).toMatchObject([{ detail: "get --real", keys: [key] }]);
    expect(await Bun.file(path.join(root, ".sikrets/activity.jsonl")).text()).not.toContain(REAL);
  });

  test("--copy copies after authenticating and schedules the clear", async () => {
    const key = await stored(REAL);
    authAs(true);
    const copied: string[] = [];
    spyOn(clipboard, "copy").mockImplementation(async (v: Secret) => void copied.push(v.reveal()));
    const clear = spyOn(clipboard, "clearLater").mockImplementation(() => {});
    await (await command("get")).run([key], { copy: true });
    expect(copied).toEqual([REAL]);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(printed()).not.toContain(REAL);
  });
});

describe("env pull --real", () => {
  test("refuses when authentication is denied, and writes nothing", async () => {
    await stored(REAL);
    authAs(false);
    await expect((await command("env")).run(["pull"], { real: true })).rejects.toThrow("stays hidden");
    expect(await Bun.file(path.join(root, ".env")).exists()).toBe(false);
  });

  test("writes real values once authenticated; plain pull never asks", async () => {
    await stored(REAL);
    const ask = authAs(true);
    await (await command("env")).run(["pull"], {});
    expect(ask).not.toHaveBeenCalled();
    expect(await Bun.file(path.join(root, ".env")).text()).not.toContain(REAL);
    await (await command("env")).run(["pull"], { real: true });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await Bun.file(path.join(root, ".env")).text()).toContain(REAL);
  });
});
