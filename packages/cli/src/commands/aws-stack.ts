import { callerAccount, deleteStack, deployStack, externalId, loadStack, quickCreateUrl } from "../core/aws-stack.ts";
import { awsProfile } from "../providers/aws.ts";
import { confirm, log } from "../ui.ts";
import { AWS_SESSION, AWS_STACK, ENV } from "../constants.ts";

// `sikrets aws connect`: deploy (or update) the Sikrets stack in your AWS account with your local
// AWS credentials, wait for it, and record its outputs. `--link` prints a CloudFormation quick-create
// link instead, for someone else to open in the console. `sikrets aws disconnect` removes it.

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export async function run(sub: "connect" | "disconnect", opts: Record<string, unknown>) {
  const profile = str(opts.profile) ?? (await awsProfile());
  const say = (m: string) => log(opts, m);

  if (sub === "connect") {
    const current = await loadStack();
    const region = str(opts.region) ?? current?.region ?? Bun.env.AWS_REGION ?? AWS_SESSION.defaultRegion;
    const stackName = str(opts.stack) ?? current?.stackName ?? AWS_STACK.defaultName;
    const trust = str(opts["trust-account"]);
    if (trust && !/^\d{12}$/.test(trust)) throw new Error(`--trust-account must be a 12-digit AWS account ID`);
    const target = { region, ...(profile ? { profile } : {}) };

    if (opts.link) {
      const templateUrl = str(opts["template-url"]) ?? Bun.env[ENV.stackTemplateUrl];
      if (!templateUrl) throw new Error(`--link needs the template's S3 URL: --template-url https://… (or set ${ENV.stackTemplateUrl})`);
      const trustedAccount = trust ?? (await callerAccount(target).catch(() => undefined));
      if (!trustedAccount) throw new Error("No AWS credentials here to read your account ID; pass --trust-account <12-digit id>");
      const ext = await externalId(region, stackName);
      const url = quickCreateUrl({ region, stackName, templateUrl, trustedAccount, externalId: ext.value });
      if (opts.json) return console.log(JSON.stringify({ url, region, stackName, trustedAccount }));
      console.log(url);
      return say(`Open the link in the AWS account that should hold the stack, tick the IAM acknowledgement, and create it. Then run: sikrets aws connect --region ${region}`);
    }

    const s = await deployStack({ ...target, stackName, ...(trust ? { trustedAccount: trust } : {}), log: say });
    if (opts.json) return console.log(JSON.stringify(s));
    return say(
      [
        `Stack ${s.stackName} ${s.action} in ${s.account} (${s.region}).`,
        `  broker role  ${s.brokerRoleArn}`,
        `  vault key    ${s.keyArn}`,
        `  boundary     ${s.boundaryArn}`,
        `  audit log    ${s.auditLogGroup}`,
        `Give an agent a role: sikrets agent role <name> --allow s3:GetObject=arn:aws:s3:::bucket/* -- <command>`,
      ].join("\n"),
    );
  }

  const s = await loadStack();
  if (!s) throw new Error("No Sikrets stack connected here; nothing to disconnect");
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error("Deleting the stack removes every agent role; pass --yes to confirm");
    if (!(await confirm(`Delete stack ${s.stackName} in ${s.account} (${s.region}) and every agent role it issued?`))) return say("Cancelled.");
  }
  const { agentRoles } = await deleteStack(s, { ...(profile ? { profile } : {}), log: say });
  if (opts.json) return console.log(JSON.stringify({ deleted: s.stackName, agentRoles }));
  say(
    [
      `Deleted stack ${s.stackName} and ${agentRoles.length} agent role${agentRoles.length === 1 ? "" : "s"}.`,
      `Kept for your records: the audit log group ${s.auditLogGroup} and the trail bucket. The KMS key is scheduled for deletion (30 days; cancel it in KMS if you still need it).`,
    ].join("\n"),
  );
}
