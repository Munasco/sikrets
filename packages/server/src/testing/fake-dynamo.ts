import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { DynamoClient } from "../dynamo.ts";

// Just enough of DynamoDB for dynamo.ts, in memory: GetItem, PutItem and UpdateItem (SET only)
// with the condition expressions the adapter uses, TransactWriteItems (Puts, all or nothing),
// DeleteItem (ALL_OLD) and Query by partition key and sort-key prefix, paged. Anything else
// throws, so the adapter can't quietly start relying on more.

type Item = Record<string, AttributeValue>;

/** Conditions as the adapter writes them: atoms joined by AND, alternatives by OR, no parentheses beyond IN (...). */
function holds(expr: string | undefined, item: Item | undefined, names: Record<string, string> = {}, values: Item = {}): boolean {
  if (!expr) return true;
  const attr = (n: string) => item?.[names[n] ?? n];
  const scalar = (v: AttributeValue | undefined) => (v === undefined ? undefined : v.N !== undefined ? Number(v.N) : v.S);
  const atom = (a: string): boolean => {
    let m: RegExpMatchArray | null;
    if ((m = a.match(/^attribute_exists\((#\w+)\)$/))) return attr(m[1]!) !== undefined;
    if ((m = a.match(/^attribute_not_exists\((#\w+)\)$/))) return attr(m[1]!) === undefined;
    if ((m = a.match(/^(#\w+) IN \(([^)]*)\)$/))) {
      const v = scalar(attr(m[1]!));
      return v !== undefined && m[2]!.split(",").map((x) => scalar(values[x.trim()])).includes(v);
    }
    if ((m = a.match(/^(#\w+) (=|>=|<) (:\w+)$/))) {
      const [l, r] = [scalar(attr(m[1]!)), scalar(values[m[3]!])];
      if (l === undefined || r === undefined) return false;
      return m[2] === "=" ? l === r : m[2] === ">=" ? l >= r : l < r;
    }
    throw new Error(`fake DynamoDB: unsupported condition ${a}`);
  };
  return expr.split(" OR ").some((alt) => alt.split(" AND ").every((a) => atom(a.trim())));
}

export function fakeDynamo(opts: { pageSize?: number } = {}): DynamoClient & { items: Map<string, Item> } {
  const items = new Map<string, Item>();
  const id = (key: Item) => `${key.pk!.S}\u0000${key.sk!.S}`;
  const fail = (name: string, message: string) => Object.assign(new Error(message), { name });

  return {
    items,
    async send(command: object) {
      const input = (command as { input: Record<string, any> }).input;
      switch (command.constructor.name) {
        case "GetItemCommand":
          return { Item: structuredClone(items.get(id(input.Key))) };
        case "PutItemCommand": {
          if (!holds(input.ConditionExpression, items.get(id(input.Item)), input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw fail("ConditionalCheckFailedException", "condition");
          items.set(id(input.Item), structuredClone(input.Item));
          return {};
        }
        case "UpdateItemCommand": {
          const existing = items.get(id(input.Key));
          if (!holds(input.ConditionExpression, existing, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw fail("ConditionalCheckFailedException", "condition");
          const m = (input.UpdateExpression as string).match(/^SET (.+)$/);
          if (!m) throw new Error("fake DynamoDB: only SET updates");
          const next: Item = structuredClone(existing ?? input.Key);
          for (const part of m[1]!.split(",")) {
            const [n, v] = part.split("=").map((x) => x.trim()) as [string, string];
            next[input.ExpressionAttributeNames[n] ?? n] = input.ExpressionAttributeValues[v];
          }
          items.set(id(input.Key), next);
          return { Attributes: structuredClone(input.ReturnValues === "ALL_OLD" ? existing : next) };
        }
        case "TransactWriteItemsCommand": {
          const puts = (input.TransactItems as { Put?: Record<string, any> }[]).map((t) => {
            if (!t.Put) throw new Error("fake DynamoDB: only Put in transactions");
            return t.Put;
          });
          if (puts.some((p) => !holds(p.ConditionExpression, items.get(id(p.Item)), p.ExpressionAttributeNames, p.ExpressionAttributeValues))) throw fail("TransactionCanceledException", "condition");
          for (const p of puts) items.set(id(p.Item), structuredClone(p.Item));
          return {};
        }
        case "DeleteItemCommand": {
          const old = items.get(id(input.Key));
          items.delete(id(input.Key));
          return input.ReturnValues === "ALL_OLD" ? { Attributes: old } : {};
        }
        case "QueryCommand": {
          if (input.KeyConditionExpression !== "#pk = :pk AND begins_with(#sk, :prefix)") throw new Error("fake DynamoDB: unsupported key condition");
          const pk = input.ExpressionAttributeValues[":pk"].S as string;
          const prefix = input.ExpressionAttributeValues[":prefix"].S as string;
          if (!prefix) throw fail("ValidationException", "begins_with needs a non-empty prefix");
          let found = [...items.values()].filter((i) => i.pk!.S === pk && i.sk!.S!.startsWith(prefix)).sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1));
          if (input.ScanIndexForward === false) found.reverse();
          if (input.ExclusiveStartKey) found = found.slice(found.findIndex((i) => id(i) === id(input.ExclusiveStartKey)) + 1);
          const limit = Math.min(input.Limit ?? Infinity, opts.pageSize ?? Infinity);
          const page = found.slice(0, limit);
          return { Items: structuredClone(page), ...(found.length > page.length ? { LastEvaluatedKey: { pk: page.at(-1)!.pk, sk: page.at(-1)!.sk } } : {}) };
        }
        default:
          throw new Error(`fake DynamoDB: unexpected ${command.constructor.name}`);
      }
    },
  };
}
