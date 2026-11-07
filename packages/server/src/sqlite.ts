import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { byName, signInStatus, type AuditEvent, type DeviceRecord, type Scope, type SignIn, type Store, type StoredValue } from "./store.ts";
import { SQLITE } from "./constants.ts";

// The SQLite store: one file in the data folder (owner-only), or in memory for tests. It serves
// `sikrets server` and tests, and works for a single server process in production too (the server
// warns at start); several server instances need DynamoDB. Records are kept as JSON next to the
// columns they are looked up by; lifecycle changes are single UPDATEs whose WHERE is the condition.

const SCHEMA = `
  create table if not exists nonces (jti text primary key, expires_at integer not null);
  create table if not exists sign_ins (request_id text primary key, user_code text not null unique, data text not null);
  create table if not exists devices (id text primary key, user text not null, data text not null);
  create index if not exists devices_by_user on devices (user);
  create table if not exists vault_values (
    account text not null, project text not null, environment text not null, name text not null,
    value text not null, updated_at text not null, updated_by text not null,
    primary key (account, project, environment, name)
  );
  create table if not exists audit (seq integer primary key autoincrement, user text not null, data text not null);
  create index if not exists audit_by_user on audit (user, seq);
  create table if not exists meta (key text primary key, value text not null);
  create table if not exists revoked_keys (jkt text primary key, revoked_at text not null);
`;

/** A sign-in's status in SQL, for rows written before the status field (see signInStatus). */
const STATUS = "coalesce(json_extract(data, '$.status'), case when json_extract(data, '$.approvedBy') is null then 'pending' else 'approved' end)";

/** `dir` holds the database file; omit it (or pass ":memory:") for an in-memory store. */
export function sqliteStore(dir: string = SQLITE.memory): Store {
  let db: Database;
  if (dir === SQLITE.memory) db = new Database(SQLITE.memory);
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, SQLITE.file);
    db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    db.run("pragma journal_mode = wal");
  }
  db.run("pragma foreign_keys = on");
  db.run(SCHEMA);

  const q = <R, P extends any[] = any[]>(sql: string) => db.query<R, P>(sql);
  const row = <T>(r: { data: string } | null) => (r ? (JSON.parse(r.data) as T) : undefined);
  const withStatus = (s: SignIn | undefined) => (s ? { ...s, status: signInStatus(s) } : undefined);
  const getSignIn = async (id: string) => withStatus(row<SignIn>(q<{ data: string }>("select data from sign_ins where request_id = ?").get(id)));

  return {
    async claimNonce(jti, expiresAt, now) {
      q("delete from nonces where expires_at < ?").run(now);
      return q("insert or ignore into nonces (jti, expires_at) values (?, ?)").run(jti, expiresAt).changes === 1;
    },

    async createSignIn(s, now) {
      // Nothing else removes old sign-ins here (DynamoDB has TTL): drop the ones past their expiry.
      q("delete from sign_ins where json_extract(data, '$.expiresAt') < ?").run(now);
      q("insert into sign_ins (request_id, user_code, data) values (?, ?, ?)").run(s.requestId, s.userCode, JSON.stringify(s));
    },
    getSignIn,
    findSignInByCode: async (code) => withStatus(row<SignIn>(q<{ data: string }>("select data from sign_ins where user_code = ?").get(code))),
    async approveSignIn(id, user, now) {
      const changed = q(`update sign_ins set data = json_set(data, '$.status', 'approved', '$.approvedBy', ?) where request_id = ? and ${STATUS} = 'pending' and json_extract(data, '$.expiresAt') >= ?`).run(user, id, now).changes;
      return changed ? getSignIn(id) : undefined;
    },
    denySignIn: async (id) => q(`update sign_ins set data = json_set(data, '$.status', 'denied') where request_id = ? and ${STATUS} = 'pending'`).run(id).changes === 1,
    async expireSignIn(id, now) {
      q(`update sign_ins set data = json_set(data, '$.status', 'expired') where request_id = ? and ${STATUS} in ('pending', 'approved') and json_extract(data, '$.expiresAt') < ?`).run(id, now);
    },
    async collectSignIn(id, now) {
      const before = await getSignIn(id);
      const changed = q(`update sign_ins set data = json_set(data, '$.status', 'collected') where request_id = ? and ${STATUS} = 'approved' and json_extract(data, '$.expiresAt') >= ?`).run(id, now).changes;
      return changed && before ? { ...before, status: "approved" } : undefined;
    },

    async createDevice(d) {
      q("insert into devices (id, user, data) values (?, ?, ?)").run(d.id, d.user, JSON.stringify(d));
    },
    getDevice: async (id) => row<DeviceRecord>(q<{ data: string }>("select data from devices where id = ?").get(id)),
    touchDevice: async (id, at) => q("update devices set data = json_set(data, '$.lastSeenAt', ?) where id = ? and json_extract(data, '$.revokedAt') is null").run(at, id).changes === 1,
    revokeDevice: async (id, at) => q("update devices set data = json_set(data, '$.revokedAt', ?) where id = ? and json_extract(data, '$.revokedAt') is null").run(at, id).changes === 1,
    async revokeKey(jkt, at) {
      q("insert or ignore into revoked_keys (jkt, revoked_at) values (?, ?)").run(jkt, at);
    },
    isKeyRevoked: async (jkt) => q("select 1 from revoked_keys where jkt = ?").get(jkt) !== null,
    listDevices: async (user) => q<{ data: string }>("select data from devices where user = ? order by id").all(user).map((r) => JSON.parse(r.data) as DeviceRecord),

    async listValues({ account, project, environment }: Scope) {
      return q<{ name: string; updated_at: string; bytes: number }>("select name, updated_at, length(value) as bytes from vault_values where account = ? and project = ? and environment = ?")
        .all(account, project, environment)
        .map((r) => ({ name: r.name, updatedAt: r.updated_at, bytes: r.bytes }))
        .sort(byName);
    },
    async getValue({ account, project, environment }, name) {
      const r = q<{ value: string; updated_at: string; updated_by: string }>("select value, updated_at, updated_by from vault_values where account = ? and project = ? and environment = ? and name = ?").get(account, project, environment, name);
      return r ? ({ name, value: r.value, updatedAt: r.updated_at, updatedBy: r.updated_by } satisfies StoredValue) : undefined;
    },
    async putValue({ account, project, environment }, v) {
      q("insert or replace into vault_values (account, project, environment, name, value, updated_at, updated_by) values (?, ?, ?, ?, ?, ?, ?)").run(account, project, environment, v.name, v.value, v.updatedAt, v.updatedBy);
    },
    createValue: async ({ account, project, environment }, v) =>
      q("insert or ignore into vault_values (account, project, environment, name, value, updated_at, updated_by) values (?, ?, ?, ?, ?, ?, ?)").run(account, project, environment, v.name, v.value, v.updatedAt, v.updatedBy).changes === 1,
    async deleteValue({ account, project, environment }, name) {
      return q("delete from vault_values where account = ? and project = ? and environment = ? and name = ?").run(account, project, environment, name).changes > 0;
    },

    async appendAudit(e) {
      q("insert into audit (user, data) values (?, ?)").run(e.user, JSON.stringify(e));
    },
    listAudit: async (user, limit) => q<{ data: string }>("select data from audit where user = ? order by seq desc limit ?").all(user, limit).map((r) => JSON.parse(r.data) as AuditEvent),

    async ensureMeta(key, value) {
      const read = () => q<{ value: string }>("select value from meta where key = ?").get(key)?.value;
      const existing = read();
      if (existing !== undefined) return existing;
      q("insert or ignore into meta (key, value) values (?, ?)").run(key, value());
      return read()!;
    },

    close: () => db.close(),
  };
}
