// What the server keeps, behind one interface. The one supported production adapter is DynamoDB
// (dynamo.ts). SQLite (sqlite.ts) is the local development and test store behind `sikrets server`,
// not a production option. Other vendors implement Store themselves and prove it with the contract
// suite (store-contract.ts); see "Writing a storage adapter" in the README. Values are `sk1:`
// envelopes sealed on the client; nothing here can open them.

export type DeviceKind = "secure-enclave" | "software";

export interface DeviceRecord {
  id: string;
  /** The account the device belongs to. */
  user: string;
  name: string;
  kind: DeviceKind;
  hardwareBound: boolean;
  registeredAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  /** The device's public signing key. */
  jwk: JsonWebKey;
}

export interface SignIn {
  requestId: string;
  jwk: JsonWebKey;
  /** RFC 7638 thumbprint of jwk: only this key may collect the sign-in. */
  jkt: string;
  name: string;
  kind: DeviceKind;
  hardwareBound: boolean;
  userCode: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The account that approved it, once someone has. */
  approvedBy?: string;
}

/** One project environment of one account. */
export interface Scope {
  account: string;
  project: string;
  environment: string;
}

export interface StoredValue {
  name: string;
  /** The sealed envelope, exactly as the client sent it. */
  value: string;
  updatedAt: string;
  /** Device that wrote it. */
  updatedBy: string;
}

export interface ValueInfo {
  name: string;
  updatedAt: string;
  bytes: number;
}

/** Names and outcomes only, never values. */
export interface AuditEvent {
  at: string;
  user: string;
  deviceId?: string;
  action: string;
  project?: string;
  environment?: string;
  name?: string;
  outcome: "ok" | "denied" | "missing";
}

export interface Store {
  /** False when the nonce was already used and hasn't expired. Atomic. */
  claimNonce(jti: string, expiresAt: number, now: number): Promise<boolean>;

  putSignIn(s: SignIn): Promise<void>;
  getSignIn(requestId: string): Promise<SignIn | undefined>;
  findSignInByCode(userCode: string): Promise<SignIn | undefined>;
  deleteSignIn(requestId: string): Promise<void>;

  putDevice(d: DeviceRecord): Promise<void>;
  getDevice(id: string): Promise<DeviceRecord | undefined>;
  listDevices(user: string): Promise<DeviceRecord[]>;

  listValues(scope: Scope): Promise<ValueInfo[]>;
  getValue(scope: Scope, name: string): Promise<StoredValue | undefined>;
  putValue(scope: Scope, value: StoredValue): Promise<void>;
  /** True when there was a value to delete. */
  deleteValue(scope: Scope, name: string): Promise<boolean>;

  appendAudit(e: AuditEvent): Promise<void>;
  /** Newest first. */
  listAudit(user: string, limit: number): Promise<AuditEvent[]>;

  /** Server settings (its certificate key). Stores `value` unless the key is set; returns what is stored. */
  ensureMeta(key: string, value: () => string): Promise<string>;

  close(): void;
}

export const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
