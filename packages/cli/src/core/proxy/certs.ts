import { mkdtemp, rm } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROXY } from "../../constants.ts";

// A certificate authority that exists for one session only. The proxy needs to read HTTPS
// requests to attach credentials, so the agent is told to trust this CA (through env vars, never
// the system keychain). The CA key never leaves the session's private folder and is deleted when
// the session ends, so there is no long-lived interception key on the machine to steal.
// Certificates are made with the system openssl (P-256, SHA-256: macOS's LibreSSL defaults to SHA-1,
// which Node, Go and Python reject); the whole set takes under ~50 ms.

export interface SessionCerts {
  /** Private folder (mode 700) holding the keys; denied to the sandboxed agent. */
  dir: string;
  /** CA certificate only, for NODE_EXTRA_CA_CERTS. */
  caFile: string;
  /** System roots plus the CA, for tools that replace the trust store (curl, Python, git). */
  bundleFile: string;
  hosts: Record<string, { cert: string; key: string }>;
  dispose: () => Promise<void>;
}

function openssl(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.toString().trim().split("\n").at(-1)}`);
}

async function systemRoots(): Promise<string> {
  for (const file of PROXY.systemRoots) if (await Bun.file(file).exists()) return Bun.file(file).text();
  throw new Error(`No system certificate bundle found (looked in ${PROXY.systemRoots.join(", ")})`);
}

export async function makeSessionCerts(hosts: readonly string[]): Promise<SessionCerts> {
  const base = await mkdtemp(path.join(os.tmpdir(), "sikrets-session-"));
  const dir = path.join(base, "keys");
  await Bun.write(path.join(dir, ".keep"), "");
  await chmod(base, 0o700);
  await chmod(dir, 0o700);
  const dispose = () => rm(base, { recursive: true, force: true });
  try {
    openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
    openssl(dir, "req", "-x509", "-new", "-key", "ca.key", "-sha256", "-subj", "/CN=Sikrets session CA", "-days", "2", "-out", "ca.pem",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign", "-addext", "subjectKeyIdentifier=hash");
    const out: SessionCerts["hosts"] = {};
    for (const host of hosts) {
      openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${host}.key`);
      openssl(dir, "req", "-new", "-key", `${host}.key`, "-subj", `/CN=${host}`, "-out", `${host}.csr`);
      await Bun.write(path.join(dir, `${host}.ext`), `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=CA:FALSE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n`);
      openssl(dir, "x509", "-req", "-in", `${host}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-sha256", "-days", "2", "-out", `${host}.pem`, "-extfile", `${host}.ext`);
      out[host] = { cert: await Bun.file(path.join(dir, `${host}.pem`)).text(), key: await Bun.file(path.join(dir, `${host}.key`)).text() };
    }
    // The agent may read these two; they hold no secrets.
    const ca = await Bun.file(path.join(dir, "ca.pem")).text();
    const caFile = path.join(base, "ca.pem");
    const bundleFile = path.join(base, "bundle.pem");
    await Bun.write(caFile, ca);
    await Bun.write(bundleFile, `${await systemRoots()}\n${ca}`);
    return { dir, caFile, bundleFile, hosts: out, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
