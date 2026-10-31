import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { record } from "../core/activity.ts";
import { hasConfig, loadConfig, type BundleEntry } from "../core/config.ts";
import { makeSessionCerts } from "../core/proxy/certs.ts";
import { sandboxed, seatbeltProfile } from "../core/proxy/sandbox.ts";
import { startProxy, type RequestLog, type Rule } from "../core/proxy/server.ts";
import { service } from "../core/proxy/services.ts";
import { tokens } from "../core/proxy/tokens.ts";
import type { Secret } from "../core/secret.ts";
import { parseDuration, until } from "../core/ttl.ts";
import { configDir } from "../store.ts";
import { PROXY } from "../constants.ts";

// `sikrets session run <bundle> -- <agent>` runs an agent with access to a bundle of services but
// none of their keys. It starts a credential proxy for this one session, gives the agent a
// session token instead of keys, and runs it in a sandbox that can't read the keychain or reach
// the network except through the proxy. The session ends when the agent exits or time runs out.

function rulesFor(bundle: string, configured: Readonly<Record<string, readonly BundleEntry[]>> | undefined): Rule[] {
  const entries: readonly BundleEntry[] = configured?.[bundle] ?? bundle.split(",").map((s) => s.trim()).filter(Boolean);
  return entries.map((e) => {
    const rule = typeof e === "string" ? { service: e } : { service: e.service, ...(e.methods ? { methods: e.methods.map((m) => m.toUpperCase()) } : {}) };
    service(rule.service); // unknown ids fail here, before anything starts
    return rule;
  });
}

export async function run(args: string[], opts: Record<string, unknown>) {
  const [sub, bundle, ...command] = args;
  if (sub !== "run" || !bundle || !command.length) throw new Error("Usage: sikrets session run <bundle|service,service> [--for 2h] -- <command>");
  const root = process.cwd();
  const config = (await hasConfig(root)) ? await loadConfig(root) : undefined;
  const rules = rulesFor(bundle, config?.bundles);
  const ttl = parseDuration(typeof opts.for === "string" ? opts.for : PROXY.defaultDuration);

  const real = new Map<string, Secret>();
  for (const r of rules) {
    const t = await tokens.get(r.service);
    if (!t) throw new Error(`No ${service(r.service).name} token yet. Add one: sikrets proxy add ${r.service}`);
    real.set(r.service, t);
  }

  const hosts = rules.flatMap((r) => Object.keys(service(r.service).hosts));
  const certs = await makeSessionCerts(hosts);
  const logDir = path.join(configDir(), PROXY.sessionsDir);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  let requests = 0;
  let denied = 0;
  let logFile = "";
  const proxy = await startProxy({
    certs,
    tokens: real,
    onlyServices: Boolean(opts["only-services"]),
    log: (e: RequestLog) => {
      requests++;
      if (e.denied) {
        denied++;
        console.error(`sikrets: denied ${e.method} ${e.host}${e.path}: ${e.denied}`);
      }
      void appendFile(logFile, JSON.stringify(e) + "\n");
    },
  });
  const session = proxy.open(bundle, rules, ttl);
  logFile = path.join(logDir, `${session.token.slice(0, 16)}.jsonl`);

  const proxyUrl = `http://sikrets:${session.token}@127.0.0.1:${proxy.port}`;
  const env: Record<string, string> = { ...(Bun.env as Record<string, string>) };
  // The agent gets the session token where SDKs look for keys, so they start up; it's useless
  // outside this proxy. Any real key in the parent environment is replaced, not passed through.
  for (const r of rules) for (const name of service(r.service).env) env[name] = session.token;
  Object.assign(env, {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: certs.caFile,
    SSL_CERT_FILE: certs.bundleFile,
    CURL_CA_BUNDLE: certs.bundleFile,
    REQUESTS_CA_BUNDLE: certs.bundleFile,
    GIT_SSL_CAINFO: certs.bundleFile,
    SIKRETS_SESSION: "1",
  });

  const sandbox = opts.sandbox !== false && !opts["no-sandbox"];
  const argv = sandbox ? sandboxed(command, seatbeltProfile({ privateDirs: [certs.dir, logDir], allowKeychain: Boolean(opts["allow-keychain"]) })) : command;
  const services = rules.map((r) => r.service + (r.methods ? ` (${r.methods.join(", ")})` : "")).join(", ");
  console.error(`sikrets: session ${session.token.slice(0, 10)}… · ${services} · ends ${until(new Date(session.expiresAt).toISOString())} · ${sandbox ? "sandboxed" : "NOT sandboxed"}`);

  const started = Date.now();
  const child = Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] });
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const code = await child.exited;
  process.off("SIGINT", forward);
  process.off("SIGTERM", forward);
  await proxy.stop();
  await certs.dispose();

  const ms = Date.now() - started;
  console.error(`sikrets: session ended · ${requests} request(s), ${denied} denied · log ${logFile}`);
  if (config) await record(root, { kind: "session", detail: `${bundle}: ${path.basename(command[0]!)} (exit ${code}, ${requests} requests, ${denied} denied)`, keys: rules.map((r) => r.service), exitCode: code, ms });
  process.exitCode = code;
}
