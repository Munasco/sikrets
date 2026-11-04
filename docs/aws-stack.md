# Self-hosting Sikrets in your AWS account

One command puts the Sikrets vault and agent identities in your own AWS account. Your secrets,
the keys that protect them, and the audit trail never leave it. Not on AWS (or GCP, once it
lands)? Use the hosted Sikrets service instead.

```sh
sikrets cloud connect --provider aws          # or: sikrets aws connect
```

This deploys [`packages/stack/sikrets.yaml`](../packages/stack/sikrets.yaml), a plain
CloudFormation template, with your local AWS credentials (your connected profile, `--profile`, or
AWS's default chain). It waits for the stack and records its outputs in
`~/.sikrets/aws-stack.json` (no secrets).

## What the stack creates

| Piece | What it does |
| --- | --- |
| `VaultKey` (KMS) | Encrypts the vault's SecureString parameters. The account can use it only through SSM, so whoever IAM lets read a parameter can decrypt it, and nobody can call KMS with it directly. |
| Vault path `/sikrets/<project>/<KEY>` | SSM Parameter Store. Values are sealed on your machine (`sk1:` envelopes, see [client-encryption.md](client-encryption.md)) before SSM sees them; KMS is the second layer. |
| `AgentBoundary` | Permissions boundary on every agent role. Agents can never touch IAM, assume other roles, write to the vault, use the key except to decrypt, silence the audit, or change this stack. |
| `AgentManagerPolicy` | Exactly what running `sikrets agent` takes. Attach it to people or CI that manage agents but aren't account admins. |
| `EventBus` + rules | Secret reads, writes (add, rotate) and deletes under `/sikrets/`, and every call an agent role makes, are forwarded to `<stack>-events`. Subscribe your own tooling (SIEM, Slack, PagerDuty) to it. |
| `AuditLogGroup`, `Trail` | The same events in CloudWatch Logs, and a multi-region CloudTrail trail (set the `CreateTrail` parameter to `false` in the console if you already have one; the CLI keeps parameters it doesn't manage). Both are kept when the stack is deleted. |
| `GitHubActionsRole` (optional) | `--github-repo owner/repo`: an agent role that repo's workflows assume with GitHub's OIDC token, so CI holds no AWS key. Pass `--github-oidc-exists` if the account already has the GitHub OIDC provider. |
| `BrokerRole` (optional, off) | `--broker-account <id>`: lets a Sikrets service in another account manage agents here, with an external ID kept in your keychain. `--broker-account none` removes it. |

No compute runs in the stack.

## Use it

```sh
# sikrets.json: "vault": "aws"
sikrets add anthropic/api-key                       # sealed, then stored under the stack's key
sikrets agent add reporter --key anthropic --expires 7d \
  --allow s3:GetObject=arn:aws:s3:::reports/*       # its own IAM role, only these secrets + actions
sikrets run --agent reporter -- python report.py    # read with the agent's own 15-minute credentials
sikrets agent role reporter -- aws s3 ls s3://reports  # hand a command the role's credentials
eval "$(sikrets agent role reporter --ttl 30m --env)"
sikrets agent revoke reporter                       # deletes the role
```

Each agent role is `sikrets-agent-<name>` under `/sikrets/agents/`, tagged `sikrets:agent=<name>`,
carries the boundary, and can be assumed only by principals in your account (and the broker, if
enabled). Its vault policy lists exactly the parameters in the agent's scope and stops working at
the agent's expiry (`aws:CurrentTime`), even for credentials already issued. Credentials last 15
to 60 minutes (`--ttl`, default 15m); nobody ever gets a long-lived key for an agent.

`--allow` takes `ACTION[,ACTION]=RESOURCE` (resource defaults to `*`, still capped by the
boundary) and replaces the agent's earlier extra permissions.

### GitHub Actions

```sh
sikrets cloud connect --provider aws --github-repo acme/api
sikrets agent add github-actions --key stripe
```

```yaml
permissions: { id-token: write, contents: read }
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with: { role-to-assume: <GitHubActionsRoleArn output>, aws-region: us-east-1 }
```

The workflow can then read the granted parameters. To open the sealed values it also needs the
project key (`sikrets env pull --project-key`, stored as a GitHub secret) and `@sikrets/sdk`.

### Without the CLI

`sikrets cloud connect --provider aws --link` prints a CloudFormation quick-create link with the
parameters filled in. It points at the published template,
https://sikrets-stack-templates.s3.amazonaws.com/stack/v1/sikrets.yaml (the same file as
`packages/stack/sikrets.yaml`); pass `--template-url` to use your own copy. Once the stack exists, run
`sikrets cloud connect --provider aws` to record it.

## Remove it

```sh
sikrets cloud disconnect --yes
```

Deletes every agent role first (the boundary can't be deleted while attached), then the stack.
The audit log group and trail bucket are kept. The KMS key is scheduled for deletion in 30 days;
cancel that in KMS if you still need to read the old parameters.

## Notes

- IAM events reach EventBridge in `us-east-1` only; deploy there, or add a rule in `us-east-1`, to see agent role creation.
- Read events (`GetParameter`) are delivered because the secret-access rule is in `ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS` state; they need a trail, which the stack creates unless `CreateTrail=false`.
- One Sikrets stack per account: the GitHub Actions role has a fixed name.

## Other clouds

Everything cloud-specific sits behind one interface (`packages/cli/src/cloud/types.ts`): deploy and
teardown, the secret store, one identity per agent, and temporary credentials. AWS is the first
implementation. GCP is planned: Secret Manager for the store, Cloud KMS for the key, a service
account per agent with IAM conditions for expiry, short-lived tokens via service account
impersonation, and Workload Identity Federation for GitHub Actions.

## Follow-ups

- GCP provider (above).
- A Sikrets-emitted "secret rotated" event on the bus (today rotation shows up as the `PutParameter` call).
- Run `cfn-lint` and `cfn-guard` on the template in CI.
