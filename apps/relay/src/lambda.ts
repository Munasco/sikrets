import { createRelay } from "./app.ts";
import { dynamoStore } from "./dynamo.ts";
import { AWS_REGION, ENV } from "./constants.ts";

// AWS Lambda behind a Function URL (payload format 2.0). Translates the event into a Request so the
// same handler runs locally, in tests and here.

interface UrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; domainName: string };
}

const table = process.env[ENV.table];
if (!table) throw new Error(`${ENV.table} is not set`);
const handle = createRelay(dynamoStore(table, process.env.AWS_REGION ?? AWS_REGION));

export async function handler(event: UrlEvent) {
  const method = event.requestContext.http.method;
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const body = event.body === undefined || method === "GET" || method === "HEAD" ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const res = await handle(new Request(url, { method, headers: event.headers, body }));
  return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}
