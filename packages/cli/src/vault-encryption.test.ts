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
import { openVault, type SsmClient } from "./core/vault.ts";
import { ENVELOPE, REVEAL } from "./constants.ts";

// Client-side encryption in the vault, and the Touch ID gate in front of anything that reveals a
// real value. The keychain and SSM are in memory, the authenticator and clipboard are faked, and
// every value is fake and assembled at runtime. Command output is captured, never printed.

const keychain = new Map<string, string>();
const ssm = new Map<string, string>();
/** Every version each SSM parameter has had, like GetParameterHistory. */
const ssmHistory = new Map<string, string[]>();
/** Runs once just before the next PutParameter: another writer slipping in. */
let beforeNextPut: (() => void) | undefined;
const ssmPut = (name: string, value: string) => {
  ssm.set(name, value);
  const h = ssmHistory.get(name) ?? [];
  h.push(value);
  ssmHistory.set(name, h);
  return h.length;
};
let root: string;
let home: string;
let cwd: string;
let out: string[];

const REAL = ["tok", "live", "fakefakefakefakefake"].join("_");
const ssmName = (project: string, key: string) => `/sikrets/${project}/${key}`;

/** Just enough of SSMClient: Get/Put/Delete one parameter (with versions and history) and list by path. */
const fakeSsm: SsmClient = {
  async send(command: object) {
    const input = (command as { input: Record<string, any> }).input;
    switch (command.constructor.name) {
      case "GetParameterCommand": {
        const value = ssm.get(input.Name);
        if (value === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Name: input.Name, Value: value, Version: ssmHistory.get(input.Name)?.length } };
      }
      case "PutParameterCommand": {
        if (input.Value.length > 4096) throw new Error("SSM would reject this: over 4 KB");
        if (input.Overwrite === false && ssm.has(input.Name)) throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
        const slip = beforeNextPut;
        beforeNextPut = undefined;
        slip?.();
        return { Version: ssmPut(input.Name, input.Value) };
      }
      case "GetParameterHistoryCommand":
        return { Parameters: (ssmHistory.get(input.Name) ?? []).map((Value, i) => ({ Name: input.Name, Value, Version: i + 1 })) };
      case "DeleteParameterCommand":
        ssmHistory.delete(input.Name);
        return void ssm.delete(input.Name);
      case "GetParametersByPathCommand":
        return { Parameters: [...ssm].filter(([n]) => n.startsWith(`${input.Path}/`)).map(([Name, Value]) => ({ Name, Value })) };
      default:
        throw new Error(`unexpected ${command.constructor.name}`);
    }
  },
};

beforeEach(async () => {
  keychain.clear();
  ssm.clear();
  ssmHistory.clear();
  beforeNextPut = undefined;
  out = [];
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-seal-"));
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-seal-home-"));
  process.env.SIKRETS_CONFIG_DIR = home;
  process.env.SIKRETS_VAULT = "keychain";
  await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo", vault: "keychain" }));
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
  delete process.env.SIKRETS_VAULT;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const raw = (project: string, key: string) => keychain.get(`dev.sikrets.vault.${project}/${key}`);
const printed = () => out.join("\n");
const command = async (name: string) => (await import(`./commands/${name}.ts`)) as { run: (args: string[], opts: Record<string, unknown>) => Promise<void> };
const authAs = (ok: boolean) =>
  spyOn(native, "authenticate").mockImplementation(async () => (ok ? { ok: true } : { ok: false, reason: "Not authenticated, so the real value stays hidden" }));

/** An applied resource whose secret is in the keychain vault. */
async function stored(value: string, over: Partial<Resource> = {}) {
  const res: Resource = { name: "anthropic", recipe: "anthropic/api-key", provider: "anthropic", strategy: "manual", inputs: {}, dependsOn: {}, envKeys: ["ANTHROPIC_API_KEY"], outputs: {}, applied: true, createdAt: new Date().toISOString(), ...over };
  await state.upsert(root, res);
  await (await openVault("demo", "keychain")).put("ANTHROPIC_API_KEY", Secret.of(value));
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
    await (await openVault("demo", "keychain")).put("API_KEY", Secret.of(REAL));
    const { createSikrets } = await import("../../sdk/src/index.ts");
    expect(await createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("API_KEY")).toBe(REAL);
  });

  test("swapping two values in the vault is caught on read", async () => {
    const vault = await openVault("demo", "keychain");
    await vault.put("A_KEY", Secret.of(REAL));
    await vault.put("B_KEY", Secret.of(`${REAL}_b`));
    keychain.set("dev.sikrets.vault.demo/A_KEY", raw("demo", "B_KEY")!);
    await expect(vault.get("A_KEY")).rejects.toThrow("Can't decrypt A_KEY");
  });
});

describe("sealed vault", () => {
  test("keychain: stores only the envelope, reads the value back", async () => {
    const vault = await openVault("demo", "keychain");
    await vault.put("API_KEY", Secret.of(REAL));
    expect(envelopeKind(raw("demo", "API_KEY")!)).toBe("sealed");
    expect(raw("demo", "API_KEY")).not.toContain(REAL);
    expect((await vault.get("API_KEY"))?.reveal()).toBe(REAL);
    expect(await vault.has("API_KEY")).toBe(true);
  });

  test("ssm: stores only the envelope, still as a SecureString under /sikrets/<project>/", async () => {
    const vault = await openVault("demo", "ssm", { ssm: fakeSsm });
    await vault.put("API_KEY", Secret.of(REAL));
    expect(envelopeKind(ssm.get(ssmName("demo", "API_KEY"))!)).toBe("sealed");
    expect((await vault.get("API_KEY"))?.reveal()).toBe(REAL);
  });

  test("legacy plaintext is refused on read, and a read writes nothing and creates no key", async () => {
    keychain.set("dev.sikrets.vault.demo/OLD_KEY", REAL);
    ssmPut(ssmName("demo", "OLD_KEY"), REAL);
    for (const [vault, read] of [
      [await openVault("demo", "keychain"), () => raw("demo", "OLD_KEY")],
      [await openVault("demo", "ssm", { ssm: fakeSsm }), () => ssm.get(ssmName("demo", "OLD_KEY"))],
    ] as const) {
      await expect(vault.get("OLD_KEY")).rejects.toThrow("sikrets seal");
      expect(read()).toBe(REAL); // untouched
    }
    expect(await loadDataKey()).toBeUndefined();
  });

  test("the first write creates the data key; a device without it can't read sealed values", async () => {
    expect(await loadDataKey()).toBeUndefined();
    const vault = await openVault("demo", "keychain");
    await vault.put("API_KEY", Secret.of(REAL));
    expect(await loadDataKey()).toBeDefined();
    await resetDevice(); // a new device: no device keys, no wrapped data key
    await expect(vault.get("API_KEY")).rejects.toThrow("sikrets recovery restore");
    // Nor does it mint a fresh key next to sealed values it can't open.
    await expect(vault.put("API_KEY", Secret.of(REAL))).rejects.toThrow("sikrets recovery restore");
    expect(await loadDataKey()).toBeUndefined();
  });

  test("ssm: a new device refuses to write while the project holds sealed values", async () => {
    await (await openVault("demo", "ssm", { ssm: fakeSsm })).put("API_KEY", Secret.of(REAL));
    await resetDevice(); // a new device: no device keys, no wrapped data key
    await expect((await openVault("demo", "ssm", { ssm: fakeSsm })).put("OTHER_KEY", Secret.of(REAL))).rejects.toThrow("sikrets recovery restore");
  });

  test("ssm: normal values fit the 4 KB Standard tier once sealed; oversize ones fail clearly", async () => {
    const vault = await openVault("demo", "ssm", { ssm: fakeSsm });
    const pem = "x".repeat(3000); // about the size of a 2048-bit private key
    await vault.put("PRIVATE_KEY", Secret.of(pem));
    expect(ssm.get(ssmName("demo", "PRIVATE_KEY"))!.length).toBeLessThanOrEqual(4096);
    await expect(vault.put("HUGE_KEY", Secret.of("x".repeat(3100)))).rejects.toThrow("too large for the ssm vault once encrypted");
    expect(ssm.has(ssmName("demo", "HUGE_KEY"))).toBe(false);
  });
});

describe("sikrets get", () => {
  test("default output is the stand-in, never the real value", async () => {
    const key = await stored(REAL);
    const ask = authAs(true);
    await (await command("get")).run([key], {});
    const standIn = (await (await openVault("demo", "keychain")).get(standInKey(key)))!.reveal();
    expect(out).toEqual([standIn]);
    expect(printed()).not.toContain(REAL);
    expect(ask).not.toHaveBeenCalled();
    // Stable: asking again prints the same stand-in.
    out.length = 0;
    await (await command("get")).run([key], { json: true });
    const json = JSON.parse(out[0]!);
    expect(json).toMatchObject({ key, standIn, project: "demo", vault: "keychain", set: true, resource: "anthropic" });
    expect(printed()).not.toContain(REAL);
  });

  test("a key without a stand-in yet (imported) gets one, persisted", async () => {
    await (await openVault("demo", "keychain")).put("IMPORTED_TOKEN", Secret.of(REAL));
    await (await command("get")).run(["IMPORTED_TOKEN"], {});
    expect(out[0]).toMatch(/^sk-sikrets-[A-Za-z0-9]{32}$/);
    expect(raw("demo", standInKey("IMPORTED_TOKEN"))).toBeDefined();
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

describe("sikrets seal", () => {
  test("lists plaintext values on a dry run, seals them with --apply, and a re-run has nothing left", async () => {
    await state.upsert(root, { name: "anthropic", recipe: "anthropic/api-key", provider: "anthropic", strategy: "manual", inputs: {}, dependsOn: {}, envKeys: ["ANTHROPIC_API_KEY"], outputs: {}, applied: true, createdAt: new Date().toISOString() });
    keychain.set("dev.sikrets.vault.demo/ANTHROPIC_API_KEY", REAL);
    await (await command("seal")).run([], { json: true });
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ apply: false, keys: [{ key: "ANTHROPIC_API_KEY", action: "seal" }] });
    expect(raw("demo", "ANTHROPIC_API_KEY")).toBe(REAL);
    await (await command("seal")).run([], { apply: true, json: true });
    expect(JSON.parse(out.at(-1)!).keys).toEqual([{ key: "ANTHROPIC_API_KEY", action: "seal", result: "sealed" }]);
    expect(envelopeKind(raw("demo", "ANTHROPIC_API_KEY")!)).toBe("sealed");
    expect((await (await openVault("demo", "keychain")).get("ANTHROPIC_API_KEY"))?.reveal()).toBe(REAL);
    await (await command("seal")).run([], { apply: true, json: true });
    expect(JSON.parse(out.at(-1)!).keys).toEqual([{ key: "ANTHROPIC_API_KEY", action: "sealed" }]);
  });

  test("a value rotated after it was read isn't overwritten by the old one", async () => {
    keychain.set("dev.sikrets.vault.demo/API_KEY", REAL);
    const vault = await openVault("demo", "keychain");
    const before = (await vault.store.getVersioned("API_KEY"))!;
    await vault.put("API_KEY", Secret.of(`${REAL}_rotated`)); // a rotation lands in between
    expect(await vault.store.replaceIf("API_KEY", before, vault.seal("API_KEY", await vault.writeKey("API_KEY"), before.value))).toBe(false);
    expect((await vault.get("API_KEY"))?.reveal()).toBe(`${REAL}_rotated`);
  });

  test("ssm: a write that slips in between the check and the put is put back", async () => {
    ssmPut(ssmName("demo", "API_KEY"), REAL);
    const vault = await openVault("demo", "ssm", { ssm: fakeSsm });
    const rotated = vault.seal("API_KEY", await vault.writeKey("API_KEY"), `${REAL}_rotated`);
    const before = (await vault.store.getVersioned("API_KEY"))!;
    beforeNextPut = () => void ssmPut(ssmName("demo", "API_KEY"), rotated);
    expect(await vault.store.replaceIf("API_KEY", before, vault.seal("API_KEY", await vault.writeKey("API_KEY"), before.value))).toBe(false);
    expect((await vault.get("API_KEY"))?.reveal()).toBe(`${REAL}_rotated`);
  });

  test("ssm: two fresh devices can't both create a data key for one project", async () => {
    await (await openVault("demo", "ssm", { ssm: fakeSsm })).put("API_KEY", Secret.of(REAL)); // device A claims the marker
    expect(ssm.get(ssmName("demo", "sikrets.datakey"))).toBeDefined();
    await resetDevice(); // device B: no device keys, no data key
    ssm.delete(ssmName("demo", "API_KEY")); // nothing sealed for B to see, only the marker
    await expect((await openVault("demo", "ssm", { ssm: fakeSsm })).put("OTHER_KEY", Secret.of(REAL))).rejects.toThrow("sikrets recovery restore");
    expect(await loadDataKey()).toBeUndefined();
  });

  test("ssm: lists the whole project folder, not just keys this checkout knows", async () => {
    process.env.SIKRETS_VAULT = "ssm";
    ssmPut(ssmName("demo", "SOMEONE_ELSES_KEY"), REAL);
    const vault = await openVault("demo", "ssm", { ssm: fakeSsm });
    expect(await vault.store.list!()).toEqual(["SOMEONE_ELSES_KEY"]);
  });
});

describe("deployed apps", () => {
  test("env pull --project-key needs Touch ID, and the key lets the SDK open values without a keychain", async () => {
    await stored(REAL);
    authAs(false);
    await expect((await command("env")).run(["pull"], { "project-key": true })).rejects.toThrow("stays hidden");
    authAs(true);
    await (await command("env")).run(["pull"], { "project-key": true });
    const env = Object.fromEntries((await Bun.file(path.join(root, ".env")).text()).split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
    expect(env.SIKRETS_PROJECT_KEY).toBeDefined();
    await resetDevice(); // a server: no device keys, no data key
    const { createSikrets } = await import("../../sdk/src/index.ts");
    expect(await createSikrets({ env: { SIKRETS_PROJECT_KEY: env.SIKRETS_PROJECT_KEY }, project: "demo", vault: "keychain" }).get("ANTHROPIC_API_KEY")).toBe(REAL);
    await expect(createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("ANTHROPIC_API_KEY")).rejects.toThrow("SIKRETS_PROJECT_KEY");
  });

  test("the SDK refuses plaintext too", async () => {
    keychain.set("dev.sikrets.vault.demo/OLD_KEY", REAL);
    const { createSikrets } = await import("../../sdk/src/index.ts");
    await expect(createSikrets({ env: {}, project: "demo", vault: "keychain" }).get("OLD_KEY")).rejects.toThrow("sikrets seal");
  });
});
