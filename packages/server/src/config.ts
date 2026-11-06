import { autoApproval, manualApproval, type ApprovalPolicy } from "./approval.ts";
import { DEFAULTS, ENV, LOOPBACK_HOSTS, VALUES } from "./constants.ts";

// Server settings from the environment. Strict: a typo fails at start instead of running with a
// default nobody chose.

export interface ServerConfig {
  host: string;
  port: number;
  store: { kind: "sqlite"; dir: string } | { kind: "aws"; table: string; region: string };
  approval: ApprovalPolicy;
  publicUrl?: string;
  /** Default: VALUES.maxValueBytes. */
  maxValueBytes?: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env, defaults: { dataDir?: string } = {}): ServerConfig {
  const host = env[ENV.host] || DEFAULTS.host;
  const port = Number(env[ENV.port] ?? DEFAULTS.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${ENV.port} must be a port number`);

  const kind = env[ENV.store] || DEFAULTS.store;
  let store: ServerConfig["store"];
  if (kind === "sqlite") {
    const dir = env[ENV.dataDir] || defaults.dataDir;
    if (!dir) throw new Error(`Set ${ENV.dataDir} to the folder the SQLite database lives in`);
    store = { kind, dir };
  } else if (kind === "aws") store = { kind, table: env[ENV.table] || DEFAULTS.table, region: env[ENV.region] || env.AWS_REGION || DEFAULTS.region };
  else throw new Error(`${ENV.store} must be "sqlite" or "aws", not "${kind}"`);

  const publicUrl = env[ENV.publicUrl] || undefined;
  if (publicUrl && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) throw new Error(`${ENV.publicUrl} must be an origin like https://sikrets.example.com`);

  const mode = env[ENV.approval] || DEFAULTS.approval;
  let approval: ApprovalPolicy;
  if (mode === "auto") {
    // Anyone who can reach an auto-approving server is signed in, so it only listens on this machine.
    if (!LOOPBACK_HOSTS.includes(host)) throw new Error(`${ENV.approval}=auto only listens on this machine (127.0.0.1); use manual approval to serve ${host}`);
    approval = autoApproval(env[ENV.localUser] || DEFAULTS.localUser);
  } else if (mode === "manual") approval = manualApproval({ adminToken: env[ENV.adminToken] || undefined });
  else throw new Error(`${ENV.approval} must be "auto" or "manual", not "${mode}"`);

  const maxValueBytes = Number(env[ENV.maxValueBytes] ?? VALUES.maxValueBytes);
  if (!Number.isInteger(maxValueBytes) || maxValueBytes < 1024) throw new Error(`${ENV.maxValueBytes} must be a whole number of bytes, at least 1024`);

  return { host, port, store, approval, publicUrl, maxValueBytes };
}
