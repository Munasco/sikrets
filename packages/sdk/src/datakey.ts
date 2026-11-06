import { execFile } from "node:child_process";
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_ENV, DATA_KEY, DEVICE, USER_DIR } from "./constants.ts";

// Finds the user's data key the way the CLI stores it (packages/cli/src/core/datakey.ts and
// device.ts): wrapped to this device's key-agreement key under ~/.sikrets/device. Software keys
// are opened here; Secure Enclave keys through the helper the CLI built, so the private key never
// leaves the Enclave. A raw key still in the keychain (from a CLI before device keys) is used as is.

interface Wrapped {
  recipient: string;
  fingerprint: string;
  epk: string;
  iv: string;
  ct: string;
  tag: string;
}

interface Meta {
  kind: "secure-enclave" | "software";
  agreementPublicKey: string;
}

type Secrets = { get(o: { service: string; name: string }): Promise<string | null> };

const readJson = async <T>(file: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const b64 = (s: string) => Buffer.from(s, "base64");

function run(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { encoding: "utf8" }, (error, stdout) => (error ? reject(new Error("this device's Secure Enclave couldn't open the data key")) : resolve(stdout.trim())));
    child.stdin?.end(input);
  });
}

export async function loadDataKey(secrets: Secrets | undefined): Promise<Buffer | undefined> {
  const raw = await secrets?.get(DATA_KEY);
  if (raw) return b64(raw);

  const root = process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), USER_DIR);
  const dir = path.join(root, DEVICE.dir);
  const [meta, wrapped] = [await readJson<Meta>(path.join(dir, DEVICE.metaFile)), await readJson<Wrapped>(path.join(dir, DEVICE.dataKeyFile))];
  if (!meta || !wrapped) return undefined;
  const recipient = createHash("sha256").update(b64(meta.agreementPublicKey)).digest("hex").slice(0, DEVICE.thumbprintChars);
  if (wrapped.recipient !== recipient) throw new Error("the data key here was wrapped for a different device (run `sikrets recovery restore`)");

  const salt = Buffer.from(DEVICE.wrapSalt);
  const info = Buffer.from(`${DEVICE.wrapInfo}|${wrapped.epk}|${meta.agreementPublicKey}`);
  const aad = Buffer.from(`${DEVICE.wrapAad}|${wrapped.fingerprint}|${recipient}`);
  const keyFile = path.join(dir, DEVICE.agreementKey);

  if (meta.kind === "secure-enclave") {
    const input = { epk: wrapped.epk, iv: wrapped.iv, ct: wrapped.ct, tag: wrapped.tag, salt: salt.toString("base64"), info: info.toString("base64"), aad: aad.toString("base64") };
    return b64(await run(path.join(root, DEVICE.helper), ["unwrap", keyFile], JSON.stringify(input)));
  }

  const epk = b64(wrapped.epk);
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: epk.subarray(1, 33).toString("base64url"), y: epk.subarray(33).toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey: createPrivateKey(await readFile(keyFile, "utf8")), publicKey });
  const key = Buffer.from(hkdfSync("sha256", shared, salt, info, 32));
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, b64(wrapped.iv)).setAAD(aad);
    decipher.setAuthTag(b64(wrapped.tag));
    return Buffer.concat([decipher.update(b64(wrapped.ct)), decipher.final()]);
  } catch {
    throw new Error("this device's key couldn't open the data key");
  }
}
