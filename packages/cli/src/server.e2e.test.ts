import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { legacy, type SsmClient } from "./commands/migrate.ts";
import { startLocal } from "./commands/server.ts";
import { readSession, savedServer, transport, writeSession } from "./core/device-auth.ts";
import { projectKey, sealValue } from "./core/envelope.ts";
import { ensureDataKey, loadDataKey } from "./core/datakey.ts";
import { thisDevice } from "./core/device.ts";
import { Secret } from "./core/secret.ts";
import { resolveServer, serverFlag } from "./core/server.ts";
import { openVault } from "./core/vault.ts";
import { startDeviceServer, type TestServer } from "./testing/device-server.ts";
import { TEST_SERVER } from "./testing/preload.ts";
import { ENV, SERVER } from "./constants.ts";

// The CLI against a real Sikrets server: `sikrets server` on a random localhost port with SQLite
// in a temp folder, signed in to, then values in and out through the commands. Also which server a
// run talks to, and `sikrets migrate` from fake legacy SSM and keychain stores. Every value is fake
// and assembled at runtime; output is captured and checked for leaks, never printed.

const keychain = new Map<string, string>();
let root: string;
let home: string;
let data: string;
let cwd: string;
let out: string[];
let running: { url: string; stop(): void } | undefined;

const REAL = ["tok", "live", "fakefakefakefakefake"].join("_");
const OTHER = ["sk", "test", "notarealkeyatall0000"].join("_");
const printed = () => out.join("\n");
const command = async (name: string) => (await import(`./commands/${name}.ts`)) as { run: (args: string[], opts: Record<string, unknown>) => Promise<void> };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(async () => {
  keychain.clear();
  out = [];
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-e2e-"));
  home = await mkdtemp(path.join(os.tmpdir(), "sikrets-e2e-home-"));
  data = await mkdtemp(path.join(os.tmpdir(), "sikrets-e2e-data-"));
  process.env[ENV.configDir] = home;
  await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo" }));
  cwd = process.cwd();
  process.chdir(root);
  spyOn(Bun.secrets, "set").mockImplementation(async ({ service, name, value }) => void keychain.set(`${service}/${name}`, value));
  spyOn(Bun.secrets, "get").mockImplementation(async ({ service, name }) => keychain.get(`${service}/${name}`) ?? null);
  spyOn(Bun.secrets, "delete").mockImplementation(async ({ service, name }) => keychain.delete(`${service}/${name}`));
  spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
});

afterEach(async () => {
  mock.restore();
  running?.stop();
  running = undefined;
  serverFlag.value = undefined;
  process.chdir(cwd);
  delete process.env[ENV.configDir];
  for (const dir of [root, home, data]) await rm(dir, { recursive: true, force: true });
});

describe("which server", () => {
  test("--server, then SIKRETS_SERVER, then sikrets.json, then the saved one, then ours", async () => {
    delete process.env[ENV.server];
    expect(await resolveServer({})).toBe(SERVER.defaultUrl);
    expect(await resolveServer({ server: "https://project.test/" })).toBe("https://project.test");
    await writeSession({ version: 1, server: "https://saved.test", deviceId: "dev_x", user: "u", certificate: "c", kind: "software", hardwareBound: false, signedInAt: new Date().toISOString() });
    expect(await resolveServer({})).toBe("https://saved.test");
    expect(await resolveServer({ server: "https://saved.test/" })).toBe("https://saved.test");
    // A committed sikrets.json never quietly wins over the server you signed in to.
    await expect(resolveServer({ server: "https://project.test/" })).rejects.toThrow("--server https://project.test or --server https://saved.test");
    expect(await resolveServer({ server: "https://project.test" }, "https://project.test")).toBe("https://project.test");
    process.env[ENV.server] = "http://env.test";
    expect(await resolveServer({ server: "https://project.test" })).toBe("http://env.test");
    serverFlag.value = "http://flag.test";
    expect(await resolveServer({ server: "https://project.test" })).toBe("http://flag.test");
    expect(await resolveServer({}, "http://explicit.test")).toBe("http://explicit.test");
    serverFlag.value = undefined;
    process.env[ENV.server] = "not a url";
    await expect(resolveServer({})).rejects.toThrow(`${ENV.server} must be a URL`);
  });

  test("sikrets.json's server must be https, unless it's on this machine", async () => {
    delete process.env[ENV.server];
    await expect(resolveServer({ server: "http://project.test" })).rejects.toThrow("must be https");
    expect(await resolveServer({ server: "http://localhost:4873" })).toBe("http://localhost:4873");
  });

  test("only a server on this machine is signed in to without sikrets login", async () => {
    const { connect } = await import("./core/server.ts");
    const remote = "http://remote.test";
    const auto = (await import("./testing/device-server.ts")).inProcessServer(remote, { autoApprove: "you@localhost" });
    const original = transport.fetch;
    transport.fetch = (input, init) => (input.startsWith(`${remote}/`) ? auto.fetch(input, init) : original(input, init));
    try {
      await expect(connect(remote)).rejects.toThrow(`Run: sikrets login --server ${remote}`);
    } finally {
      transport.fetch = original;
      auto.stop();
    }
  });

  test("logout revokes the key for good; the next login makes new device keys and keeps the data key", async () => {
    const key = await ensureDataKey();
    await (await command("login")).run([], { "no-browser": true });
    const first = (await readSession(TEST_SERVER))!;
    const oldKey = (await thisDevice()).signingPublicKey.toString("base64");
    await (await command("logout")).run([], {});
    expect(await readSession(TEST_SERVER)).toBeUndefined();
    await (await command("login")).run([], { "no-browser": true });
    const second = (await readSession(TEST_SERVER))!;
    expect(second.deviceId).not.toBe(first.deviceId);
    expect((await thisDevice()).signingPublicKey.toString("base64")).not.toBe(oldKey);
    expect((await loadDataKey())!.equals(key)).toBe(true);
  });

  test("login to a project's own server doesn't change the saved server for other projects", async () => {
    delete process.env[ENV.server];
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo", server: TEST_SERVER }));
    await (await command("login")).run([], { "no-browser": true });
    expect(await readSession(TEST_SERVER)).toBeDefined();
    expect(await savedServer()).toBeUndefined();
  });

  test("commands follow it: sikrets.json's server is used for the project's vault", async () => {
    delete process.env[ENV.server];
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo", server: TEST_SERVER }));
    await Bun.write(path.join(root, ".env"), `API_KEY=${REAL}\n`);
    await (await command("import")).run([".env"], { yes: true });
    expect(await (await openVault("demo", TEST_SERVER)).has("API_KEY")).toBe(true);
    expect(printed()).toContain(`into the vault on ${TEST_SERVER}`);
    expect(printed()).not.toContain(REAL);
  });
});

describe("sikrets server, end to end", () => {
  test("login, import, get (stand-in), run (real value), env; only ciphertext on the server", async () => {
    delete process.env[ENV.server];
    const server = await startLocal({ port: 0, dataDir: data });
    running = server;
    await (await command("login")).run([], { server: server.url, "no-browser": true });
    expect(printed()).toContain(`Signed in as ${SERVER.localUser} on ${server.url}`);
    expect((await readSession())?.server).toBe(server.url);

    await Bun.write(path.join(root, ".env"), `API_KEY=${REAL}\nOTHER_TOKEN=${OTHER}\n`);
    await (await command("import")).run([".env"], { yes: true });

    out.length = 0;
    await (await command("get")).run(["API_KEY"], {});
    expect(out[0]).toMatch(/^sk-sikrets-[A-Za-z0-9]{32}$/);

    // The child process is the only thing that sees the value; it writes back a hash.
    const proof = path.join(root, "seen.txt");
    await (await command("run")).run(["sh", "-c", `printf %s "$API_KEY" | shasum -a 256 | cut -d' ' -f1 > ${JSON.stringify(proof)}`], {});
    expect((await Bun.file(proof).text()).trim()).toBe(sha(REAL));

    out.length = 0;
    await (await command("env")).run([], { json: true });
    expect(JSON.parse(out[0]!).server).toBe(server.url);
    expect(printed()).not.toContain(REAL);

    // On disk the server holds envelopes and names, nothing else.
    running.stop();
    running = undefined;
    const db = Bun.file(path.join(data, "sikrets.db"));
    const bytes = Buffer.from(await db.arrayBuffer()).toString("latin1");
    expect(bytes).toContain("API_KEY");
    expect(bytes).toContain("sk1:");
    for (const v of [REAL, OTHER]) expect(bytes).not.toContain(v);
  });

  test("the SDK reads through the server it's signed in to, never an old SSM copy", async () => {
    delete process.env[ENV.server];
    const server = await startLocal({ port: 0, dataDir: data });
    running = server;
    await (await command("login")).run([], { server: server.url, "no-browser": true });
    const vault = await openVault("demo", server.url);
    await vault.put("API_KEY", Secret.of(REAL));
    const { createSikrets } = await import("../../sdk/src/index.ts");
    // No SIKRETS_SERVER: the server `sikrets login` saved is the one read; vault "ssm" (no AWS here) is never touched.
    const sdk = createSikrets({ env: { API_KEY: "sk-sikrets-AAAAbbbbCCCCddddEEEEffffGGGGhhhh" }, project: "demo", vault: "ssm" });
    expect(await sdk.get("API_KEY")).toBe(REAL);
    // Rotated on the server: the SDK sees the new value (after its cache), not a pre-migration copy.
    await vault.put("API_KEY", Secret.of(OTHER));
    sdk.clear();
    expect(await sdk.get("API_KEY")).toBe(OTHER);
    await expect(createSikrets({ env: {}, project: "demo" }).get("MISSING_KEY")).rejects.toThrow(`not in the server ${server.url}`);
  });

  test("`sikrets server` as its own process: answers, signs this device in on first use, stops on Ctrl-C", async () => {
    const cli = path.join(import.meta.dir, "index.ts");
    const proc = Bun.spawn(["bun", cli, "server", "--port", "0", "--data", data], { stdout: "pipe", stderr: "pipe", env: { ...process.env, [ENV.configDir]: home } });
    try {
      const reader = proc.stderr.getReader();
      let banner = "";
      while (!/http:\/\/127\.0\.0\.1:\d+/.test(banner)) {
        const { value, done } = await reader.read();
        if (done) break;
        banner += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const url = banner.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
      expect(banner).toContain("Local development server");
      expect(banner).toContain("approved automatically");
      process.env[ENV.server] = url;
      // No `sikrets login`: a server that approves sign-ins itself is signed in to on first use.
      const vault = await openVault("demo");
      await vault.put("API_KEY", Secret.of(REAL));
      expect((await vault.get("API_KEY"))?.reveal()).toBe(REAL);
      expect((await readSession(url))?.user).toBe(SERVER.localUser);
      // That isn't a `sikrets login`, so it doesn't become the profile's saved server.
      expect(await readSession()).toBeUndefined();
    } finally {
      proc.kill("SIGINT");
      expect(await proc.exited).toBe(0);
    }
  }, 20_000);

  test("a server that needs approval isn't signed in to behind your back", async () => {
    const manual: TestServer = startDeviceServer();
    try {
      process.env[ENV.server] = manual.url;
      await expect((await openVault("demo")).list()).rejects.toThrow(`This device isn't signed in to ${manual.url}. Run: sikrets login --server ${manual.url}`);
    } finally {
      manual.stop();
    }
  });

  test("an unreachable server is reported as such", async () => {
    process.env[ENV.server] = "http://127.0.0.1:9";
    await expect((await openVault("demo")).list()).rejects.toThrow("Can't reach the Sikrets server at http://127.0.0.1:9");
  });
});

describe("sikrets migrate", () => {
  const ssm = new Map<string, string>();
  const fakeSsm: SsmClient = {
    async send(command: object) {
      const input = (command as { input: Record<string, any> }).input;
      if (command.constructor.name !== "GetParametersByPathCommand") throw new Error(`unexpected ${command.constructor.name}`);
      expect(input.WithDecryption).toBe(true);
      return { Parameters: [...ssm].filter(([n]) => n.startsWith(`${input.Path}/`)).map(([Name, Value]) => ({ Name, Value })) };
    },
  };
  beforeEach(() => {
    ssm.clear();
    spyOn(legacy, "ssm").mockImplementation(async () => fakeSsm);
  });

  async function legacyValues() {
    const sealed = sealValue(projectKey(await ensureDataKey(), "demo"), "demo", "SEALED_KEY", REAL);
    ssm.set("/sikrets/demo/SEALED_KEY", sealed);
    ssm.set("/sikrets/demo/PLAIN_KEY", OTHER);
    ssm.set("/sikrets/demo/FUTURE_KEY", "sk9:AAAA");
    ssm.set("/sikrets/other/NOT_THIS_PROJECT", REAL);
    return sealed;
  }

  test("dry run by default: lists what would move, uploads nothing", async () => {
    await legacyValues();
    await (await command("migrate")).run([], {});
    expect(printed()).toContain("Dry run — would migrate demo from the ssm vault");
    expect(printed()).toContain("+ PLAIN_KEY  seal here, then upload");
    expect(printed()).toContain("+ SEALED_KEY  upload (already sealed)");
    expect(printed()).toContain("· FUTURE_KEY  skip: written by a newer Sikrets");
    expect(printed()).not.toContain("NOT_THIS_PROJECT");
    expect(await (await openVault("demo")).list()).toEqual([]);
    for (const v of [REAL, OTHER]) expect(printed()).not.toContain(v);
  });

  test("--apply uploads sealed values as is, seals plaintext first, skips what's there; legacy copies stay", async () => {
    const sealed = await legacyValues();
    const vault = await openVault("demo");
    await vault.put("PLAIN_KEY", Secret.of("already-moved"));
    await (await command("migrate")).run([], { apply: true, json: true });
    const report = JSON.parse(out.at(-1)!);
    expect(report).toMatchObject({ project: "demo", from: "ssm", server: TEST_SERVER, apply: true, moved: 1 });
    expect(report.items).toEqual([
      { name: "FUTURE_KEY", action: "newer-format" },
      { name: "PLAIN_KEY", action: "on-server" },
      { name: "SEALED_KEY", action: "upload" },
    ]);
    const { testServer } = await import("./testing/preload.ts");
    expect((await testServer().store.getValue({ account: "you@localhost", project: "demo", environment: SERVER.environment }, "SEALED_KEY"))?.value).toBe(sealed);
    expect((await vault.get("SEALED_KEY"))?.reveal()).toBe(REAL);
    expect((await vault.get("PLAIN_KEY"))?.reveal()).toBe("already-moved");
    expect(ssm.size).toBe(4);
    for (const v of [REAL, OTHER]) expect(printed()).not.toContain(v);
  });

  test("from the keychain: the project's known names and their stand-ins, sealed on the way", async () => {
    await Bun.write(path.join(root, "sikrets.json"), JSON.stringify({ project: "demo", vault: "keychain" }));
    await Bun.write(path.join(root, ".sikrets/keys.json"), JSON.stringify({ version: 1, keys: [{ key: "API_KEY", source: ".env", addedAt: "2026-11-01T00:00:00.000Z" }, { key: "GONE_KEY", source: ".env", addedAt: "2026-11-01T00:00:00.000Z" }] }));
    keychain.set("dev.sikrets.vault.demo/API_KEY", REAL);
    keychain.set("dev.sikrets.vault.demo/SIKRETS_STANDIN__API_KEY", "sk-sikrets-abcdefghijklmnopqrstuvwxyzABCDEF");
    await (await command("migrate")).run([], {});
    expect(printed()).toContain("from the keychain vault");
    expect(await (await openVault("demo")).list()).toEqual([]);
    out.length = 0;
    await (await command("migrate")).run([], { apply: true });
    expect(printed()).toContain("Moved 2 value(s). The keychain copies are untouched");
    const vault = await openVault("demo");
    expect(await vault.list()).toEqual(["API_KEY", "SIKRETS_STANDIN__API_KEY"]);
    expect((await vault.get("API_KEY"))?.reveal()).toBe(REAL);
    expect(keychain.get("dev.sikrets.vault.demo/API_KEY")).toBe(REAL);
    expect(printed()).not.toContain(REAL);
  });

  test("a sealed value that doesn't open with this device's key is never uploaded", async () => {
    await ensureDataKey();
    const { randomBytes } = await import("node:crypto");
    ssm.set("/sikrets/demo/FOREIGN_KEY", sealValue(projectKey(randomBytes(32), "demo"), "demo", "FOREIGN_KEY", REAL)); // another data key
    ssm.set("/sikrets/demo/MOVED_KEY", sealValue(projectKey(await ensureDataKey(), "demo"), "demo", "OTHER_NAME", REAL)); // copied from another name
    await (await command("migrate")).run([], { apply: true, json: true });
    expect(JSON.parse(out.at(-1)!).items).toEqual([
      { name: "FOREIGN_KEY", action: "unreadable" },
      { name: "MOVED_KEY", action: "unreadable" },
    ]);
    expect(await (await openVault("demo")).list()).toEqual([]);
  });

  test("a value written on the server while migrate runs is kept, not overwritten", async () => {
    const sealed = await legacyValues();
    const vault = await openVault("demo");
    const { testServer } = await import("./testing/preload.ts");
    const scope = { account: "you@localhost", project: "demo", environment: SERVER.environment };
    // The server's list is read before the uploads; a rotation lands in between.
    const list = testServer().store.listValues.bind(testServer().store);
    const rotated = sealValue(projectKey(await ensureDataKey(), "demo"), "demo", "SEALED_KEY", "rotated-meanwhile");
    let once = true;
    spyOn(testServer().store, "listValues").mockImplementation(async (sc) => {
      const before = await list(sc);
      if (once) await testServer().store.putValue(scope, { name: "SEALED_KEY", value: rotated, updatedAt: new Date().toISOString(), updatedBy: "dev_other" });
      once = false;
      return before;
    });
    await (await command("migrate")).run([], { apply: true, json: true });
    const report = JSON.parse(out.at(-1)!);
    expect(report.items).toContainEqual({ name: "SEALED_KEY", action: "on-server" });
    expect((await vault.get("SEALED_KEY"))?.reveal()).toBe("rotated-meanwhile");
    expect((await testServer().store.getValue(scope, "SEALED_KEY"))?.value).not.toBe(sealed);
  });

  test("nothing to move, and a bad --from, are explained", async () => {
    await (await command("migrate")).run([], {});
    expect(printed()).toContain("Nothing to migrate: no values for demo in the ssm vault.");
    await expect((await command("migrate")).run([], { from: "s3" })).rejects.toThrow("--from must be ssm or keychain");
  });
});
