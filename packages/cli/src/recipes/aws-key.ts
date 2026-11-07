import { splitAwsKey } from "../core/aws-session.ts";
import { defineManualRecipe } from "./types.ts";
import { AWS_SESSION } from "../constants.ts";

// A long-lived IAM access key, kept only so `sikrets aws session` can trade it for 15–60 minute
// credentials. Stored as one value, ACCESS_KEY_ID:SECRET_ACCESS_KEY, so a rotation replaces both.
export const accessKey = defineManualRecipe({
  id: "aws/access-key",
  provider: "aws",
  summary: "An IAM user access key, used only to issue short-lived sessions",
  defaultName: "aws-key",
  inputs: {},
  requires: [],
  outputs: { key: { description: "AWS access key, as ACCESS_KEY_ID:SECRET_ACCESS_KEY", env: "ACCESS_KEY", sensitive: true } },
  secret: "key",
  pattern: /^AKIA[A-Z0-9]{16}:[A-Za-z0-9/+=]{40}$/,
  instructions: {
    url: AWS_SESSION.securityCredentials,
    steps: [
      "Create an access key for an IAM user with only the permissions agents should get (or that may assume narrower roles)",
      "Paste it as ACCESS_KEY_ID:SECRET_ACCESS_KEY",
    ],
  },
  estimate: () => "free",

  async verify(key) {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const client = new STSClient({ region: Bun.env.AWS_REGION || AWS_SESSION.defaultRegion, credentials: splitAwsKey(key) });
    try {
      await client.send(new GetCallerIdentityCommand({}));
    } catch {
      throw new Error("AWS rejected this key: it's mistyped, inactive or deleted");
    } finally {
      client.destroy();
    }
  },
});
