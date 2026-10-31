// Services the proxy can attach credentials for. Each maps hosts to how the real token goes on the
// request. Anything not listed here is tunnelled untouched (or refused with --only-services).

export interface Service {
  id: string;
  name: string;
  /** Where to create a token, shown by `sikrets proxy add`. */
  tokenUrl: string;
  hosts: Record<string, (token: string) => Record<string, string>>;
  /** Env vars SDKs read the key from; the agent gets the session token in them, never the key. */
  env: string[];
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const SERVICES: readonly Service[] = [
  {
    id: "github",
    name: "GitHub",
    tokenUrl: "https://github.com/settings/personal-access-tokens",
    hosts: {
      "api.github.com": bearer,
      "uploads.github.com": bearer,
      // git over HTTPS sends Basic auth; GitHub accepts any username with a token as the password.
      "github.com": (token) => ({ authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }),
    },
    env: ["GITHUB_TOKEN", "GH_TOKEN"],
  },
  { id: "slack", name: "Slack", tokenUrl: "https://api.slack.com/apps", hosts: { "slack.com": bearer }, env: ["SLACK_BOT_TOKEN", "SLACK_TOKEN"] },
  {
    id: "anthropic",
    name: "Anthropic",
    tokenUrl: "https://platform.claude.com/settings/keys",
    hosts: { "api.anthropic.com": (token) => ({ "x-api-key": token }) },
    env: ["ANTHROPIC_API_KEY"],
  },
  { id: "openai", name: "OpenAI", tokenUrl: "https://platform.openai.com/api-keys", hosts: { "api.openai.com": bearer }, env: ["OPENAI_API_KEY"] },
  { id: "resend", name: "Resend", tokenUrl: "https://resend.com/api-keys", hosts: { "api.resend.com": bearer }, env: ["RESEND_API_KEY"] },
  { id: "stripe", name: "Stripe", tokenUrl: "https://dashboard.stripe.com/apikeys", hosts: { "api.stripe.com": bearer }, env: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"] },
];

export function service(id: string): Service {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown service "${id}". Known: ${SERVICES.map((x) => x.id).join(", ")}`);
  return s;
}

/** Headers an agent might use to send its own credentials; the proxy always replaces them. */
export const AUTH_HEADERS = ["authorization", "x-api-key", "proxy-authorization"] as const;
