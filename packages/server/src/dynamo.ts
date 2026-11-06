import { DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { byName, type AuditEvent, type DeviceRecord, type Scope, type SignIn, type Store, type StoredValue } from "./store.ts";
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
//   SIGNIN#<requestId>           -                    a pending sign-in (TTL)
//   CODE#<userCode>              -                    -> requestId (TTL)
//   DEVICE#<id>                  -                    -> account
//   ACCOUNT#<account>            DEVICE#<id>          the device record
//   VAULT#<account>#<project>#<env>   VALUE#<name>    a sealed value
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
const conditionFailed = (e: unknown) => (e as { name?: string })?.name === "ConditionalCheckFailedException";

export function dynamoStore(client: DynamoClient, table: string): Store {
  const get = async (pk: string, sk?: string) => (await client.send(new GetItemCommand({ TableName: table, Key: key(pk, sk), ConsistentRead: true }))).Item as Item | undefined;
  const put = (i: Item) => client.send(new PutItemCommand({ TableName: table, Item: i }));
  const del = (pk: string, sk?: string) => client.send(new DeleteItemCommand({ TableName: table, Key: key(pk, sk), ReturnValues: "ALL_OLD" }));

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

    async putSignIn(s) {
      const ttl = Math.ceil(s.expiresAt / 1000);
      await put(item(`SIGNIN#${s.requestId}`, NONE, s, ttl));
      await put(item(`CODE#${s.userCode}`, NONE, { requestId: s.requestId }, ttl));
    },
    getSignIn: async (id) => parse<SignIn>(await get(`SIGNIN#${id}`)),
    async findSignInByCode(code) {
      const pointer = parse<{ requestId: string }>(await get(`CODE#${code}`));
      return pointer ? parse<SignIn>(await get(`SIGNIN#${pointer.requestId}`)) : undefined;
    },
    async deleteSignIn(id) {
      const old = parse<SignIn>((await del(`SIGNIN#${id}`)).Attributes);
      if (old) await del(`CODE#${old.userCode}`);
    },

    async putDevice(d) {
      await put(item(`ACCOUNT#${d.user}`, `DEVICE#${d.id}`, d));
      await put(item(`DEVICE#${d.id}`, NONE, { user: d.user }));
    },
    async getDevice(id) {
      const pointer = parse<{ user: string }>(await get(`DEVICE#${id}`));
      return pointer ? parse<DeviceRecord>(await get(`ACCOUNT#${pointer.user}`, `DEVICE#${id}`)) : undefined;
    },
    listDevices: async (user) => (await query(`ACCOUNT#${user}`, "DEVICE#")).map((i) => parse<DeviceRecord>(i)!),

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
    deleteValue: async (scope, name) => Boolean((await del(vault(scope), `VALUE#${name}`)).Attributes),

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
