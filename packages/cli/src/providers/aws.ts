import { listConnections, saveConnection } from "../store.ts";

// AWS needs no browser: it reuses a profile from your AWS CLI config (SSO or access keys). Sikrets
// records which profile to use; the credentials themselves stay in ~/.aws, managed by AWS tooling.

export async function awsProfile(): Promise<string | undefined> {
  return (await listConnections()).find((c) => c.provider === "aws")?.account.split("@")[0] || Bun.env.AWS_PROFILE;
}

export async function awsClientConfig(): Promise<{ profile?: string }> {
  const profile = await awsProfile();
  return profile ? { profile } : {};
}

/** Environment Terraform's AWS provider needs: just the profile name, never key material. */
export async function awsEnv(): Promise<Record<string, string>> {
  const profile = await awsProfile();
  return profile ? { AWS_PROFILE: profile, AWS_SDK_LOAD_CONFIG: "1" } : {};
}

export async function connectAws(profile: string, log: (m: string) => void) {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const who = await new STSClient({ profile }).send(new GetCallerIdentityCommand({}));
  if (!who.Account) throw new Error(`AWS profile "${profile}" did not return an account`);
  if (who.Arn?.endsWith(":root")) {
    log(`Warning: profile "${profile}" uses the AWS account root user. Use an IAM user or SSO role instead (sikrets connect aws --profile <name>).`);
  }
  await saveConnection({ provider: "aws", account: `${profile}@${who.Account}`, mode: "profile", connectedAt: new Date().toISOString() });
  log(`Connected AWS account ${who.Account} via profile "${profile}" (${who.Arn?.split(":").at(-1)})`);
  return { profile, account: who.Account };
}
