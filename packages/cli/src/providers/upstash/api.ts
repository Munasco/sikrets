// Thin client for the Upstash Developer API (https://api.upstash.com/v2, basic auth email:apiKey).
export interface UpstashDatabase {
  database_id: string;
  database_name: string;
  endpoint: string;
  port: number;
  password?: string;
  rest_token?: string;
  type?: string;
  budget?: number;
  primary_region?: string;
}

export class Upstash {
  constructor(private email: string, private apiKey: string) {}

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.upstash.com/v2${route}`, {
      method,
      headers: {
        Authorization: `Basic ${btoa(`${this.email}:${this.apiKey}`)}`,
        "Content-Type": "application/json",
        "User-Agent": "sikrets-cli",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Upstash ${method} ${route.split("?")[0]} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listDatabases = () => this.request<UpstashDatabase[]>("GET", "/redis/databases?credentials=hide");
  createDatabase = (body: { database_name: string; platform: "aws" | "gcp"; primary_region: string; plan: string; budget?: number; tls: true }) =>
    this.request<UpstashDatabase>("POST", "/redis/database", body);
  deleteDatabase = (id: string) => this.request<void>("DELETE", `/redis/database/${encodeURIComponent(id)}`);
  resetPassword = (id: string) => this.request<UpstashDatabase>("POST", `/redis/reset-password/${encodeURIComponent(id)}`);
  stats = (id: string) => this.request<{ total_monthly_billing?: number }>("GET", `/redis/stats/${encodeURIComponent(id)}`);
}

export const restUrl = (endpoint: string) => `https://${endpoint.includes(".") ? endpoint : `${endpoint}.upstash.io`}`;
