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

/** Temporary credentials as the AWS SDK takes them, e.g. a broker session used to call IAM. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface StsRequest {
  /** A stored long-lived key; without it `credentials`, the profile, or AWS's default chain is used. */
  key?: Secret;
  /** Temporary credentials to call STS with (role chaining). */
  credentials?: AwsCredentials;
  profile?: string;
  region: string;
  seconds: number;
  role?: string;
  /** Required by roles that trust another account with an external ID. */
  externalId?: string;
  sessionName?: string;
}

/** Calls STS: AssumeRole when a role is given, else GetSessionToken. Returns the temporary set only. */
export async function stsCredentials(o: StsRequest): Promise<AwsCredentials> {
  const { STSClient, AssumeRoleCommand, GetSessionTokenCommand } = await import("@aws-sdk/client-sts");
  const auth = o.key ? { credentials: splitAwsKey(o.key) } : o.credentials ? { credentials: o.credentials } : o.profile ? { profile: o.profile } : {};
  const client = new STSClient({ region: o.region, ...auth });
  try {
    const out = o.role
      ? await client.send(
          new AssumeRoleCommand({
            RoleArn: o.role,
            RoleSessionName: o.sessionName ?? AWS_SESSION.roleSessionName,
            DurationSeconds: o.seconds,
            ...(o.externalId ? { ExternalId: o.externalId } : {}),
          }),
        )
      : await client.send(new GetSessionTokenCommand({ DurationSeconds: o.seconds }));
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error("STS returned no credentials");
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: new Date(c.Expiration) };
  } finally {
    client.destroy();
  }
}

/** The environment a temporary set is handed out as; the secret halves stay masked. */
export function sessionEnv(c: AwsCredentials, region: string, role?: string): AwsSession {
  const expiresAt = c.expiration.toISOString();
  return {
    env: {
      AWS_ACCESS_KEY_ID: c.accessKeyId,
      AWS_SECRET_ACCESS_KEY: Secret.of(c.secretAccessKey),
      AWS_SESSION_TOKEN: Secret.of(c.sessionToken),
      AWS_CREDENTIAL_EXPIRATION: expiresAt,
      AWS_REGION: region,
    },
    expiresAt,
    ...(role ? { role } : {}),
  };
}

export async function awsSession(o: {
  /** A stored long-lived key; without it the connected profile (or AWS's default chain) is used. */
  key?: Secret;
  profile?: string;
  region: string;
  seconds: number;
  role?: string;
}): Promise<AwsSession> {
  return sessionEnv(await stsCredentials(o), o.region, o.role);
}
