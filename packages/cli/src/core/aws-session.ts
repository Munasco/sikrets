import { parseDuration } from "./ttl.ts";
import { Secret } from "./secret.ts";
import { AWS_SESSION } from "../constants.ts";

// Short-lived AWS credentials. A long-lived key (stored in the vault, or the connected AWS
// profile's) asks STS for credentials that expire in 15 to 60 minutes: GetSessionToken for the
// key's own permissions, or AssumeRole for a narrower role. Only the temporary set is handed out.

/** A stored AWS key is kept as one value, ACCESS_KEY_ID:SECRET, so rotating it replaces both halves. */
export function splitAwsKey(value: Secret): { accessKeyId: string; secretAccessKey: string } {
  const raw = value.reveal();
  const i = raw.indexOf(":");
  if (i <= 0) throw new Error("A stored AWS key must be ACCESS_KEY_ID:SECRET_ACCESS_KEY");
  return { accessKeyId: raw.slice(0, i), secretAccessKey: raw.slice(i + 1) };
}

/** Session length in seconds, from a duration like 15m or 1h, within STS's and our limits. */
export function sessionSeconds(duration: string): number {
  const minutes = parseDuration(duration) / 60_000;
  if (minutes < AWS_SESSION.minMinutes || minutes > AWS_SESSION.maxMinutes) {
    throw new Error(`Sessions last ${AWS_SESSION.minMinutes}m to ${AWS_SESSION.maxMinutes}m; got ${duration}`);
  }
  return minutes * 60;
}

export interface AwsSession {
  env: Record<string, string | Secret>;
  expiresAt: string;
  /** Assumed role ARN, when a role was assumed. */
  role?: string;
}

export async function awsSession(o: {
  /** A stored long-lived key; without it the connected profile (or AWS's default chain) is used. */
  key?: Secret;
  profile?: string;
  region: string;
  seconds: number;
  role?: string;
}): Promise<AwsSession> {
  const { STSClient, AssumeRoleCommand, GetSessionTokenCommand } = await import("@aws-sdk/client-sts");
  const client = new STSClient({ region: o.region, ...(o.key ? { credentials: splitAwsKey(o.key) } : o.profile ? { profile: o.profile } : {}) });
  try {
    const out = o.role
      ? await client.send(new AssumeRoleCommand({ RoleArn: o.role, RoleSessionName: AWS_SESSION.roleSessionName, DurationSeconds: o.seconds }))
      : await client.send(new GetSessionTokenCommand({ DurationSeconds: o.seconds }));
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error("STS returned no credentials");
    const expiresAt = new Date(c.Expiration).toISOString();
    return {
      env: {
        AWS_ACCESS_KEY_ID: c.AccessKeyId,
        AWS_SECRET_ACCESS_KEY: Secret.of(c.SecretAccessKey),
        AWS_SESSION_TOKEN: Secret.of(c.SessionToken),
        AWS_CREDENTIAL_EXPIRATION: expiresAt,
        AWS_REGION: o.region,
      },
      expiresAt,
      ...(o.role ? { role: o.role } : {}),
    };
  } finally {
    client.destroy();
  }
}
