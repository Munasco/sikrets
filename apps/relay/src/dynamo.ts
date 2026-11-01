import { DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { Store } from "./store.ts";

// DynamoDB: partition key "box", sort key "id", and "exp" as the table's TTL attribute. TTL deletion
// is lazy, so reads also filter out expired items.

export function dynamoStore(table: string, region: string): Store {
  const db = new DynamoDBClient({ region });
  return {
    async put(box, msg) {
      await db.send(new PutItemCommand({ TableName: table, Item: { box: { S: box }, id: { S: msg.id }, blob: { S: msg.blob }, exp: { N: String(msg.expiresAt) } } }));
    },
    async list(box, now) {
      const out = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "box = :b",
          FilterExpression: "exp > :now",
          ExpressionAttributeValues: { ":b": { S: box }, ":now": { N: String(now) } },
        }),
      );
      return (out.Items ?? []).map((i) => ({ id: i.id!.S!, blob: i.blob!.S!, expiresAt: Number(i.exp!.N) }));
    },
    async remove(box, id) {
      await db.send(new DeleteItemCommand({ TableName: table, Key: { box: { S: box }, id: { S: id } } }));
    },
  };
}
