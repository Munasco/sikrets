// What the server keeps, behind one interface. The one supported production adapter is DynamoDB
// (dynamo.ts). SQLite (sqlite.ts) is the local development and test store behind `sikrets server`,
// not a production option. Other vendors implement Store themselves and prove it with the contract
// suite (store-contract.ts); see "Writing a storage adapter" in the README. Values are `sk1:`
// envelopes sealed on the client; nothing here can open them.

export type DeviceKind = "secure-enclave" | "software";

// Writes that change a lifecycle are single conditional operations in every store, so two
// requests racing can't both win and an old snapshot can't be written back over a newer state:
// - a device: active → revoked, and never back. Being seen only sets lastSeenAt on an active device.
// - a key: once revoked, refused for good (all its devices, and any new sign-in with it).
// - a sign-in: pending → approved | denied | expired, approved → collected | expired. Approve and
//   collect each succeed once; the record stays until it expires, so it can't be approved again.

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

export type SignInStatus = "pending" | "approved" | "denied" | "expired" | "collected";

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
  status: SignInStatus;
  /** The account that approved it, once someone has. */
  approvedBy?: string;
}

/** Records written before `status` existed: approved if someone approved, else pending. */
export const signInStatus = (s: Omit<SignIn, "status"> & { status?: SignInStatus }): SignInStatus => s.status ?? (s.approvedBy ? "approved" : "pending");

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

  /** Stores a new pending sign-in and its user-code pointer together (one transaction). Also drops long-expired ones. */
  createSignIn(s: SignIn, now: number): Promise<void>;
  getSignIn(requestId: string): Promise<SignIn | undefined>;
  findSignInByCode(userCode: string): Promise<SignIn | undefined>;
  /** pending → approved as `user`, only while pending and unexpired. Undefined when it wasn't. */
  approveSignIn(requestId: string, user: string, now: number): Promise<SignIn | undefined>;
  /** pending → denied. False when it wasn't pending. */
  denySignIn(requestId: string): Promise<boolean>;
  /** pending or approved → expired, once past expiresAt. */
  expireSignIn(requestId: string, now: number): Promise<void>;
  /** approved → collected, once, while unexpired. Returns the sign-in as it was approved, or undefined. */
  collectSignIn(requestId: string, now: number): Promise<SignIn | undefined>;

  /** Registers a new device (its record and id pointer together). Fails if the id exists. */
  createDevice(d: DeviceRecord): Promise<void>;
  getDevice(id: string): Promise<DeviceRecord | undefined>;
  listDevices(user: string): Promise<DeviceRecord[]>;
  /** Sets lastSeenAt on an active device only. False when it is revoked (or gone). */
  touchDevice(id: string, at: string): Promise<boolean>;
  /** active → revoked. False when it already was (or is gone); revokedAt is never rewritten. */
  revokeDevice(id: string, at: string): Promise<boolean>;
  /** Refuses this key (RFC 7638 thumbprint) from now on, whatever device id it comes with. */
  revokeKey(jkt: string, at: string): Promise<void>;
  isKeyRevoked(jkt: string): Promise<boolean>;

  listValues(scope: Scope): Promise<ValueInfo[]>;
  getValue(scope: Scope, name: string): Promise<StoredValue | undefined>;
  putValue(scope: Scope, value: StoredValue): Promise<void>;
  /** Stores the value only if the name is free. False when one exists (nothing written). */
  createValue(scope: Scope, value: StoredValue): Promise<boolean>;
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
