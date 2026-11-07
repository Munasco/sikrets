import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { record } from "../core/activity.ts";
import { hasConfig, loadConfig, type BundleEntry } from "../core/config.ts";
import { makeSessionCerts, sweepStaleSessions } from "../core/proxy/certs.ts";
import { sandboxed, seatbeltProfile } from "../core/proxy/sandbox.ts";
import { startProxy, type Proxy, type RequestLog, type Rule, type SessionState } from "../core/proxy/server.ts";
import { service } from "../core/proxy/services.ts";
import { tokens } from "../core/proxy/tokens.ts";
import type { Secret } from "../core/secret.ts";
import { parseDuration, until } from "../core/ttl.ts";
import { configDir } from "../store.ts";
import { PROXY } from "../constants.ts";

// `sikrets session run <bundle> -- <agent>` runs an agent with access to a bundle of services but
// none of their keys. It starts a credential proxy for this one session, gives the agent a
// session token instead of keys, and runs it in a sandbox that can't read the keychain or reach
// the network except through the proxy. The session ends when the agent exits or time runs out;
// when time runs out the agent is stopped too (SIGTERM, then SIGKILL). Whatever happens, the
// session's CA key is deleted on the way out, and folders left by a killed session are swept on
// the next start. Real tokens are read once, at start: `sikrets proxy rm` or a new token takes
// effect in the next session.

function rulesFor(bundle: string, configured: Readonly<Record<string, readonly BundleEntry[]>> | undefined): Rule[] {
  const entries: readonly BundleEntry[] = configured?.[bundle] ?? bundle.split(",").map((s) => s.trim()).filter(Boolean);
  return entries.map((e) => {
    const rule = typeof e === "string" ? { service: e } : { service: e.service, ...(e.methods ? { methods: e.methods.map((m) => m.toUpperCase()) } : {}) };
    service(rule.service); // unknown ids fail here, before anything starts
    return rule;
  });
}

/** Test seams: where real tokens come from, and the session length in ms instead of --for. */
export interface SessionDeps {
  getToken?: (service: string) => Promise<Secret | undefined>;
  ttlMs?: number;
}

export async function run(args: string[], opts: Record<string, unknown>, deps: SessionDeps = {}) {
  const [sub, bundle, ...command] = args;
  if (sub !== "run" || !bundle || !command.length) throw new Error("Usage: sikrets session run <bundle|service,service> [--for 2h] -- <command>");
  const root = process.cwd();
  const config = (await hasConfig(root)) ? await loadConfig(root) : undefined;
  const rules = rulesFor(bundle, config?.bundles);
  const ttl = deps.ttlMs ?? parseDuration(typeof opts.for === "string" ? opts.for : PROXY.defaultDuration);

  const real = new Map<string, Secret>();
  for (const r of rules) {
    const t = await (deps.getToken ?? tokens.get)(r.service);
    if (!t) throw new Error(`No ${service(r.service).name} token yet. Add one: sikrets proxy add ${r.service}`);
    real.set(r.service, t);
  }

  await sweepStaleSessions();
  const hosts = rules.flatMap((r) => Object.keys(service(r.service).hosts));
  const logDir = path.join(configDir(), PROXY.sessionsDir);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.jsonl`);
  let requests = 0;
  let denied = 0;

  // Signals while setting up mean "don't start"; once the agent runs, they're passed on to it.
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const forward = (sig: NodeJS.Signals) => (child ? child.kill(sig) : (interrupted ??= sig));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const sig of signals) process.on(sig, forward);

  const certs = await makeSessionCerts(hosts);
  let proxy: Proxy | undefined;
  let ended: Exclude<SessionState, "open"> | undefined;
  let code = 1;
  const started = Date.now();
  try {
    proxy = await startProxy({
      certs,
      tokens: real,
      onlyServices: Boolean(opts["only-services"]),
      log: (e: RequestLog) => {
        requests++;
        if (e.denied) {
          denied++;
          console.error(`sikrets: denied ${e.method} ${e.host}${e.path}: ${e.denied}`);
        }
        appendFile(logFile, JSON.stringify(e) + "\n").catch(() => undefined);
      },
    });
    const session = proxy.open(bundle, rules, ttl, (state) => {
      ended = state;
      if (state !== "expired" || !child) return;
      // Access already ended at the proxy; the agent doesn't get to keep running without it.
      console.error("sikrets: session time is up; stopping the agent");
      child.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), PROXY.killGraceMs).unref();
    });

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

    if (interrupted) throw new Error(`Stopped by ${interrupted} before the agent started`);
    child = Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] });
    code = await child.exited;
  } finally {
    for (const sig of signals) process.off(sig, forward);
    await proxy?.stop();
    await certs.dispose();
  }

  const ms = Date.now() - started;
  const how = ended === "expired" ? "time ran out" : `exit ${code}`;
  console.error(`sikrets: session ended (${how}) · ${requests} request(s), ${denied} denied · log ${logFile}`);
  if (config) await record(root, { kind: "session", detail: `${bundle}: ${path.basename(command[0]!)} (${how}, ${requests} requests, ${denied} denied)`, keys: rules.map((r) => r.service), exitCode: code, ms });
  process.exitCode = code;
}
