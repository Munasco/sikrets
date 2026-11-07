import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { byName, type AuditEvent, type DataKeyClaim, type DeviceRecord, type Scope, type SignIn, type SignInStatus, type Store, type StoredValue } from "./store.ts";
import { DYNAMO } from "./constants.ts";

// The AWS adapter: one DynamoDB table (string partition key `pk`, string sort key `sk`, TTL on
// `expiresAt`). DynamoDB rather than SSM Parameter Store because the server keeps more than values
// (devices, sign-ins, audit, one-time nonces): conditional writes make nonce claims atomic across
// server instances, items hold up to 400 KB where SSM's Standard tier stops at 4 KB, and there are
// no per-account parameter quotas or 40 TPS throttle. Each item's record is a JSON string in
// `data`; values in it are the client's sealed envelopes, so KMS encryption at rest is a second
// layer, not the only one.
//
//   NONCE#<jti>                  -                    a used proof nonce (TTL)
//   SIGNIN#<requestId>           -                    a sign-in, with status/approvedBy/expiresAtMs as attributes (TTL)
//   CODE#<userCode>              -                    -> requestId (TTL)
//   DEVICE#<id>                  -                    -> account
//   ACCOUNT#<account>            DEVICE#<id>          the device record, with lastSeenAt/revokedAt as attributes
//   REVOKEDKEY#<jkt>             -                    a device key refused for good
//   VAULT#<account>#<project>#<env>   VALUE#<name>    a sealed value
//   DATAKEY#<account>#<project>  -                    the data-key fingerprint the project is sealed under (created once)
//   AUDIT#<account>              EVENT#<time>#<rand>  an audit event
//   META#<key>                   -                    server settings

/** The one method of DynamoDBClient used, so tests can pass a fake. */
export interface DynamoClient {
  send(command: object): Promise<any>;
}

type Item = Record<string, AttributeValue>;

const { pk: PK, sk: SK, data: DATA, ttl: TTL, none: NONE } = DYNAMO;
const key = (pk: string, sk: string = NONE): Item => ({ [PK]: { S: pk }, [SK]: { S: sk } });
const item = (pk: string, sk: string, data: unknown, expiresAt?: number): Item => ({
  ...key(pk, sk),
  [DATA]: { S: JSON.stringify(data) },
  ...(expiresAt === undefined ? {} : { [TTL]: { N: String(expiresAt) } }),
});
const parse = <T>(i: Item | undefined): T | undefined => (i?.[DATA]?.S === undefined ? undefined : (JSON.parse(i[DATA].S) as T));
const vault = ({ account, project, environment }: Scope) => `VAULT#${account}#${project}#${environment}`;
const dataKey = (account: string, project: string) => `DATAKEY#${account}#${project}`;
const conditionFailed = (e: unknown) => ["ConditionalCheckFailedException", "TransactionCanceledException"].includes((e as { name?: string })?.name ?? "");
const S = (v: string): AttributeValue => ({ S: v });
const N = (v: number): AttributeValue => ({ N: String(v) });
const str = (i: Item | undefined, name: string) => i?.[name]?.S;

/** A record from `data`, with the lifecycle attributes laid over it. */
function signInOf(i: Item | undefined): SignIn | undefined {
  const s = parse<SignIn>(i);
  if (!s) return undefined;
  const approvedBy = str(i, DYNAMO.approvedBy) ?? s.approvedBy;
  return { ...s, status: (str(i, DYNAMO.status) as SignInStatus | undefined) ?? (approvedBy ? "approved" : "pending"), ...(approvedBy ? { approvedBy } : {}) };
}
function deviceOf(i: Item | undefined): DeviceRecord | undefined {
  const d = parse<DeviceRecord>(i);
  if (!d) return undefined;
  const lastSeenAt = str(i, DYNAMO.lastSeenAt) ?? d.lastSeenAt;
  const revokedAt = str(i, DYNAMO.revokedAt) ?? d.revokedAt;
  return { ...d, ...(lastSeenAt ? { lastSeenAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
}

export function dynamoStore(client: DynamoClient, table: string): Store {
  const get = async (pk: string, sk?: string) => (await client.send(new GetItemCommand({ TableName: table, Key: key(pk, sk), ConsistentRead: true }))).Item as Item | undefined;
  const put = (i: Item) => client.send(new PutItemCommand({ TableName: table, Item: i }));
  const del = (pk: string, sk?: string) => client.send(new DeleteItemCommand({ TableName: table, Key: key(pk, sk), ReturnValues: "ALL_OLD" }));

  /**
   * SET the given attributes if `condition` holds; undefined when it doesn't. Condition names
   * available: #pk, #status, #exp (expiresAtMs), #revokedAt.
   */
  async function update(pk: string, sk: string, set: Item, condition: string, values: Item = {}, returnValues?: "ALL_NEW" | "ALL_OLD"): Promise<Item | undefined> {
    const names: Record<string, string> = { "#pk": PK, "#status": DYNAMO.status, "#exp": DYNAMO.expiresAtMs, "#revokedAt": DYNAMO.revokedAt };
    const assignments = Object.keys(set).map((attr, i) => ((names[`#s${i}`] = attr), `#s${i} = :s${i}`));
    const used = (n: string) => condition.includes(n) || assignments.some((a) => a.startsWith(n));
    try {
      const out = await client.send(
        new UpdateItemCommand({
          TableName: table,
          Key: key(pk, sk),
          UpdateExpression: `SET ${assignments.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: Object.fromEntries(Object.entries(names).filter(([n]) => used(n))),
          ExpressionAttributeValues: { ...values, ...Object.fromEntries(Object.values(set).map((v, i) => [`:s${i}`, v])) },
          ReturnValues: returnValues ?? "ALL_NEW",
        }),
      );
      return (out.Attributes as Item | undefined) ?? {};
    } catch (error) {
      if (conditionFailed(error)) return undefined;
      throw error;
    }
  }

  /** Every item under a partition whose sort key starts with `prefix`, following pages. */
  async function query(pk: string, prefix: string, opts: { newestFirst?: boolean; limit?: number } = {}): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": PK, "#sk": SK },
          ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: prefix } },
          ScanIndexForward: !opts.newestFirst,
          ConsistentRead: true,
          ...(opts.limit ? { Limit: opts.limit - items.length } : {}),
          ExclusiveStartKey,
        }),
      );
      items.push(...((page.Items ?? []) as Item[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey && (!opts.limit || items.length < opts.limit));
    return items;
  }

  return {
    async claimNonce(jti, expiresAt, now) {
      try {
        // A nonce item TTL hasn't swept yet doesn't count once it has expired.
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: item(`NONCE#${jti}`, NONE, {}, expiresAt),
            ConditionExpression: "attribute_not_exists(#pk) OR #ttl < :now",
            ExpressionAttributeNames: { "#pk": PK, "#ttl": TTL },
            ExpressionAttributeValues: { ":now": { N: String(now) } },
          }),
        );
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },

    async createSignIn(s, now) {
      const ttl = Math.ceil(s.expiresAt / 1000);
      const { status, approvedBy, ...rest } = s;
      const signIn = { ...item(`SIGNIN#${s.requestId}`, NONE, rest, ttl), [DYNAMO.status]: S(status), [DYNAMO.expiresAtMs]: N(s.expiresAt), ...(approvedBy ? { [DYNAMO.approvedBy]: S(approvedBy) } : {}) };
      // Both items or neither; a user code still held by a live sign-in isn't taken over.
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: table, Item: signIn, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": PK } } },
            { Put: { TableName: table, Item: item(`CODE#${s.userCode}`, NONE, { requestId: s.requestId }, ttl), ConditionExpression: "attribute_not_exists(#pk) OR #ttl < :now", ExpressionAttributeNames: { "#pk": PK, "#ttl": TTL }, ExpressionAttributeValues: { ":now": N(Math.floor(now / 1000)) } } },
          ],
        }),
      );
    },
    getSignIn: async (id) => signInOf(await get(`SIGNIN#${id}`)),
    async findSignInByCode(code) {
      const pointer = parse<{ requestId: string }>(await get(`CODE#${code}`));
      return pointer ? signInOf(await get(`SIGNIN#${pointer.requestId}`)) : undefined;
    },
    async approveSignIn(id, user, now) {
      const out = await update(`SIGNIN#${id}`, NONE, { [DYNAMO.status]: S("approved"), [DYNAMO.approvedBy]: S(user) }, "#status = :pending AND #exp >= :now", { ":pending": S("pending"), ":now": N(now) }, "ALL_NEW");
      return out && signInOf(out);
    },
    denySignIn: async (id) => Boolean(await update(`SIGNIN#${id}`, NONE, { [DYNAMO.status]: S("denied") }, "#status = :pending", { ":pending": S("pending") })),
    async expireSignIn(id, now) {
      await update(`SIGNIN#${id}`, NONE, { [DYNAMO.status]: S("expired") }, "#status IN (:pending, :approved) AND #exp < :now", { ":pending": S("pending"), ":approved": S("approved"), ":now": N(now) });
    },
    async collectSignIn(id, now) {
      const old = await update(`SIGNIN#${id}`, NONE, { [DYNAMO.status]: S("collected") }, "#status = :approved AND #exp >= :now", { ":approved": S("approved"), ":now": N(now) }, "ALL_OLD");
      return old && signInOf(old);
    },

    async createDevice(d) {
      const { lastSeenAt: _seen, revokedAt: _revoked, ...record } = d;
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: table, Item: item(`ACCOUNT#${d.user}`, `DEVICE#${d.id}`, record), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": PK } } },
            { Put: { TableName: table, Item: item(`DEVICE#${d.id}`, NONE, { user: d.user }), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": PK } } },
          ],
        }),
      );
    },
    async getDevice(id) {
      const pointer = parse<{ user: string }>(await get(`DEVICE#${id}`));
      return pointer ? deviceOf(await get(`ACCOUNT#${pointer.user}`, `DEVICE#${id}`)) : undefined;
    },
    listDevices: async (user) => (await query(`ACCOUNT#${user}`, "DEVICE#")).map((i) => deviceOf(i)!),
    async touchDevice(id, at) {
      const pointer = parse<{ user: string }>(await get(`DEVICE#${id}`));
      return Boolean(pointer && (await update(`ACCOUNT#${pointer.user}`, `DEVICE#${id}`, { [DYNAMO.lastSeenAt]: S(at) }, "attribute_exists(#pk) AND attribute_not_exists(#revokedAt)")));
    },
    async revokeDevice(id, at) {
      const pointer = parse<{ user: string }>(await get(`DEVICE#${id}`));
      return Boolean(pointer && (await update(`ACCOUNT#${pointer.user}`, `DEVICE#${id}`, { [DYNAMO.revokedAt]: S(at) }, "attribute_exists(#pk) AND attribute_not_exists(#revokedAt)")));
    },
    async revokeKey(jkt, at) {
      await put(item(`REVOKEDKEY#${jkt}`, NONE, { revokedAt: at }));
    },
    isKeyRevoked: async (jkt) => Boolean(await get(`REVOKEDKEY#${jkt}`)),

    async listValues(scope) {
      return (await query(vault(scope), "VALUE#"))
        .map((i) => parse<StoredValue>(i)!)
        .map((v) => ({ name: v.name, updatedAt: v.updatedAt, bytes: Buffer.byteLength(v.value) }))
        .sort(byName);
    },
    getValue: async (scope, name) => parse<StoredValue>(await get(vault(scope), `VALUE#${name}`)),
    async putValue(scope, v) {
      await put(item(vault(scope), `VALUE#${v.name}`, v));
    },
    async createValue(scope, v) {
      try {
        await client.send(new PutItemCommand({ TableName: table, Item: item(vault(scope), `VALUE#${v.name}`, v), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": PK } }));
        return true;
      } catch (error) {
        if (conditionFailed(error)) return false;
        throw error;
      }
    },
    deleteValue: async (scope, name) => Boolean((await del(vault(scope), `VALUE#${name}`)).Attributes),

    getDataKeyClaim: async (account, project) => parse<DataKeyClaim>(await get(dataKey(account, project))),
    async claimDataKey(account, project, claim) {
      try {
        await client.send(new PutItemCommand({ TableName: table, Item: item(dataKey(account, project), NONE, claim), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": PK } }));
        return claim;
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
      return parse<DataKeyClaim>(await get(dataKey(account, project)))!;
    },

    async appendAudit(e) {
      await put(item(`AUDIT#${e.user}`, `EVENT#${e.at}#${randomBytes(6).toString("hex")}`, e));
    },
    listAudit: async (user, limit) => (await query(`AUDIT#${user}`, "EVENT#", { newestFirst: true, limit })).map((i) => parse<AuditEvent>(i)!),

    async ensureMeta(name, value) {
      const existing = parse<{ value: string }>(await get(`META#${name}`));
      if (existing) return existing.value;
      try {
        await client.send(new PutItemCommand({ TableName: table, Item: item(`META#${name}`, NONE, { value: value() }), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": PK } }));
      } catch (error) {
        if (!conditionFailed(error)) throw error;
      }
      return parse<{ value: string }>(await get(`META#${name}`))!.value;
    },

    close: () => {},
  };
}
