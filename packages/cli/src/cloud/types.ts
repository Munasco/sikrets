import type { Env } from "../core/credentials.ts";

// Self-hosting Sikrets in your own cloud account. Everything cloud-specific sits behind this
// interface: deploying and tearing down the stack, the secret store the vault writes its sealed
// (sk1:) values to, one identity per agent, and the temporary credentials an agent uses. AWS is
// implemented (cloud/aws.ts); GCP is planned (docs/aws-stack.md). Without either, use the hosted
// Sikrets service.

export type CloudId = "aws";

/** Raw stored values, exactly as written: the vault seals before put and opens after get. */
export interface SecretStore {
  /** Full name of a key's stored value, which is also each value's associated data when sealed. */
  path(key: string): string;
  /** Every value under this project, keyed by vault key. */
  list(): Promise<Map<string, string>>;
  get(key: string): Promise<string | undefined>;
  put(key: string, stored: string): Promise<void>;
  /** Writes only if the value doesn't exist. False when something got there first. */
  create(key: string, stored: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Copies kept while a value is deleted and recreated (see core/migrate.ts), keyed by vault key. */
  staged(): Promise<Map<string, string>>;
  stage(key: string, stored: string): Promise<void>;
  unstage(key: string): Promise<void>;
  /** The data-key fingerprint the project is sealed under, if one has been claimed. */
  marker(): Promise<string | undefined>;
  /** Claims the project for this fingerprint unless one is already claimed; returns the one that holds. */
  claimMarker(fingerprint: string): Promise<string>;
}

/** Options for deploying the stack; a provider ignores what doesn't apply to it. */
export interface DeployOptions {
  region?: string;
  /** Local CLI profile to deploy with (AWS: an AWS CLI profile). */
  profile?: string;
  /** Stack (or deployment) name. */
  name?: string;
  /** owner/repo whose GitHub Actions workflows get an agent identity, via OIDC. "" removes it. */
  githubRepository?: string;
  /** The account already trusts GitHub's OIDC issuer; don't create another provider. */
  githubOidcExists?: boolean;
  /** Optional: another account a Sikrets service may manage agents from. "none" removes it. */
  brokerAccount?: string;
  log: (message: string) => void;
}

export interface Deployment {
  provider: CloudId;
  name: string;
  account: string;
  region: string;
  action: "created" | "updated" | "unchanged";
  /** Labelled outputs worth showing (ARNs, paths, bus names), no secrets. */
  outputs: [label: string, value: string][];
  /** The full provider-specific record, for --json. */
  details: object;
}

/** What an agent may use: the vault secrets in its scope, until `expiresAt`, plus extra cloud permissions. */
export interface AgentGrant {
  name: string;
  /** Identities are per project: the same agent name in two projects gets two. */
  project: string;
  /** Vault keys; undefined keeps what the identity has. */
  keys?: string[];
  expiresAt?: string;
  /** Extra provider permissions (AWS: ACTION[,ACTION]=RESOURCE), usable until `expiresAt`; undefined keeps what it has. */
  allow?: string[];
}

/** Where the stack is (see aws-stack.ts StackStatus); `name` is unset when none is recorded. */
export interface StackSummary {
  provider: CloudId;
  name?: string;
  status: string;
  /** The cloud's own status word, e.g. CloudFormation's UPDATE_ROLLBACK_COMPLETE. */
  detail?: string;
  account?: string;
  region?: string;
  /** What to do about it, when it isn't usable. */
  hint?: string;
}

export interface AgentIdentity {
  /** AWS: the role ARN. */
  id: string;
  created: boolean;
}

export interface TemporaryCredentials {
  /** Environment a command gets, secret halves masked. */
  env: Env;
  expiresAt: string;
  identity: string;
  /** Provider-specific credentials, for opening the secret store as the agent. */
  handle: unknown;
}

export interface CloudProvider {
  id: CloudId;
  name: string;
  /** A stack is recorded here, in any state (usable or not). */
  connected(): Promise<boolean>;
  /** Asks the cloud where the recorded stack is now, and records the answer. */
  status(o?: { profile?: string }): Promise<StackSummary>;
  deploy(o: DeployOptions): Promise<Deployment>;
  /** A console link that deploys the stack, for someone without the CLI. */
  deployLink(o: DeployOptions & { templateUrl: string }): Promise<string>;
  /**
   * Removes every agent identity, then the stack, in any state but mid-change. `name` targets a
   * stack that isn't recorded here (one whose first deploy failed elsewhere). A stack that's already
   * gone is just forgotten (`forgotten`).
   */
  teardown(o: { profile?: string; name?: string; region?: string; log: (message: string) => void }): Promise<{ name: string; agentIdentities: string[]; kept: string[]; forgotten: boolean }>;
  /** The secret store for one project; `as` reads with an agent's temporary credentials instead of yours. */
  secretStore(project: string, o?: { as?: TemporaryCredentials }): Promise<SecretStore>;
  /** Throws if --allow values aren't valid for this cloud, before anything is called. */
  checkAllow(allow: readonly string[]): void;
  /** Creates or updates the agent's identity under the stack's permissions boundary (or the cloud's equivalent). */
  ensureAgentIdentity(grant: AgentGrant): Promise<AgentIdentity>;
  /** Deletes the project's identity for it (or, for one the stack owns, strips what Sikrets granted). Idempotent; false if there was none. */
  removeAgentIdentity(project: string, name: string): Promise<boolean>;
  /** The project's identity for the agent as the cloud has it, with its expiry. Undefined if none. */
  describeAgentIdentity(project: string, name: string): Promise<{ id: string; expiresAt?: string } | undefined>;
  /** Short-lived credentials for the agent's identity in this project. */
  issueCredentials(project: string, agent: string, o: { seconds: number; identity?: AgentIdentity; profile?: string }): Promise<TemporaryCredentials>;
}
