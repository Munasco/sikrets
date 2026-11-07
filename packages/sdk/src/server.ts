import { execFile } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, sign as signWith } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_ENV, DEVICE, ENV, SERVER_API, USER_DIR } from "./constants.ts";

// Reading through a Sikrets server, the way the CLI does: which server (the same order as the CLI:
// SIKRETS_SERVER, "server" in sikrets.json, then the one `sikrets login` saved), and a GET signed
// with this device's key (a proof like packages/cli/src/core/proof.ts). The server only holds
// sealed envelopes; index.ts opens them here. When no server is configured at all, the SDK reads
// the legacy vault (SSM or the keychain) instead.

interface Session {
  server: string;
  deviceId: string;
}
interface SessionFile {
  version: 1 | 2;
  current?: string;
  sessions?: Record<string, Session>;
  server?: string;
  deviceId?: string;
}

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const normalize = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
};

const userDir = () => process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), USER_DIR);
const deviceDir = () => path.join(userDir(), DEVICE.dir);

async function sessions(): Promise<{ current?: string; all: Record<string, Session> }> {
  const f = await readJson<SessionFile>(path.join(deviceDir(), DEVICE.sessionFile));
  if (!f) return { all: {} };
  if (f.version === 1 && f.server && f.deviceId) return { current: normalize(f.server), all: { [normalize(f.server)]: { server: f.server, deviceId: f.deviceId } } };
  return { current: f.current, all: f.sessions ?? {} };
}

/** The server to read from, or undefined when none is configured (then the legacy vault is read). */
export async function configuredServer(explicit: string | undefined, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  if (explicit) return normalize(explicit);
  if (env[ENV.server]) return normalize(env[ENV.server]!);
  const { current } = await sessions();
  const project = (await readJson<{ server?: string }>(path.join(process.cwd(), SERVER_API.configFile)))?.server;
  if (project) {
    const url = normalize(project);
    // As in the CLI: a committed sikrets.json never silently wins over the server you signed in to.
    if (current && current !== url) throw new Error(`sikrets.json names the server ${url}, but this device signed in to ${current}; set ${ENV.server} to the one to use`);
    return url;
  }
  return current;
}

/** Signs with this device's key: in-process for software keys, through the CLI's helper for Secure Enclave keys. */
async function signer(): Promise<(data: Buffer) => Promise<Buffer>> {
  const meta = await readJson<{ kind: "secure-enclave" | "software" }>(path.join(deviceDir(), DEVICE.metaFile));
  if (!meta) throw new Error("this device has no Sikrets device key; run: sikrets login");
  const keyFile = path.join(deviceDir(), DEVICE.signingKey);
  if (meta.kind === "software") {
    const key = createPrivateKey(await readFile(keyFile, "utf8"));
    return async (data) => signWith("sha256", data, { key, dsaEncoding: "ieee-p1363" });
  }
  return (data) =>
    new Promise((resolve, reject) => {
      const child = execFile(path.join(userDir(), DEVICE.helper), ["sign", keyFile], { encoding: "utf8" }, (error, stdout) => (error ? reject(new Error("this device's Secure Enclave couldn't sign the request")) : resolve(Buffer.from(stdout.trim(), "base64"))));
      child.stdin?.end(data);
    });
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");

/** A fetch of one sealed value from `server`, signed as this device. Undefined when it isn't stored. */
export function serverFetch(server: string, fetchImpl: typeof fetch = fetch, environment: string = SERVER_API.environment) {
  let ready: Promise<{ deviceId: string; sign: (data: Buffer) => Promise<Buffer> }> | undefined;
  const setup = () =>
    (ready ??= (async () => {
      const session = (await sessions()).all[server];
      if (!session) throw new Error(`this device isn't signed in to ${server}; run: sikrets login --server ${server}`);
      return { deviceId: session.deviceId, sign: await signer() };
    })().catch((error) => {
      ready = undefined;
      throw error;
    }));

  return async (project: string, key: string): Promise<string | undefined> => {
    const { deviceId, sign } = await setup();
    const url = `${server}${SERVER_API.value(project, environment, key)}`;
    const u = new URL(url);
    const header = { typ: SERVER_API.proofType, alg: SERVER_API.alg, kid: deviceId };
    const claims = { htm: "GET", htu: `${u.origin}${u.pathname}${u.search}`, iat: Math.floor(Date.now() / 1000), jti: randomBytes(SERVER_API.nonceBytes).toString("base64url"), bh: createHash("sha256").update("").digest("base64url") };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const proof = `${input}.${b64url(await sign(Buffer.from(input)))}`;
    const res = await fetchImpl(url, { method: "GET", headers: { [SERVER_API.proofHeader]: proof } });
    if (res.status === 404) return undefined;
    const body = (await res.json().catch(() => ({}))) as { value?: string; error?: string; reason?: string };
    if (!res.ok) throw new Error(`${server} refused the request (${res.status} ${body.error ?? "error"}${body.reason ? `: ${body.reason}` : ""})`);
    return body.value;
  };
}
