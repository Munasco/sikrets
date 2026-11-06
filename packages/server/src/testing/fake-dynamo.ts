import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { DynamoClient } from "../dynamo.ts";

// Just enough of DynamoDB for dynamo.ts, in memory: GetItem, PutItem (with the two condition
// expressions the adapter uses), DeleteItem (ALL_OLD) and Query by partition key and sort-key
// prefix, paged. Anything else throws, so the adapter can't quietly start relying on more.

type Item = Record<string, AttributeValue>;

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
          const existing = items.get(id(input.Item));
          const condition = input.ConditionExpression as string | undefined;
          if (condition === "attribute_not_exists(#pk)") {
            if (existing) throw fail("ConditionalCheckFailedException", "exists");
          } else if (condition === "attribute_not_exists(#pk) OR #ttl < :now") {
            const expired = existing && Number(existing.expiresAt?.N) < Number(input.ExpressionAttributeValues[":now"].N);
            if (existing && !expired) throw fail("ConditionalCheckFailedException", "exists");
          } else if (condition !== undefined) throw new Error(`fake DynamoDB: unsupported condition ${condition}`);
          items.set(id(input.Item), structuredClone(input.Item));
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
