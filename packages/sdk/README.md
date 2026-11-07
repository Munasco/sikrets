# @sikrets/sdk

Your project's `.env` and hosting platform hold **stand-ins** (`sk-sikrets-…`), not real keys. Ask for the real value at runtime:

```ts
import { sikrets } from "@sikrets/sdk";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: await sikrets.get("ANTHROPIC_API_KEY") });
```

`sikrets.get(key)`:

1. If the environment already has the **real** value (under `sikrets run`, or injected in production), returns it.
2. If it has a **stand-in** or nothing, fetches the real value from the project's vault with the app's own credentials, and caches it for 5 minutes so rotated keys are picked up.

It never returns a stand-in, and its errors (`SikretsError` with `code`: `not-found`, `invalid-key`, `vault`, `decrypt`) never contain values.

Values in SSM are encrypted by the CLI before upload (`sk1:…`), so AWS stores ciphertext. The SDK opens them with the project key; legacy plaintext values pass through until `sikrets migrate encrypt` has run.

## Configuration

| Env var | Default | |
| --- | --- | --- |
| `SIKRETS_PROJECT` | working directory name | which project's vault to read |
| `SIKRETS_VAULT` | `ssm` | `ssm` (AWS SSM Parameter Store) or `keychain` (Bun, local only) |
| `SIKRETS_PROJECT_KEY` | Bun: derived from the keychain data key | base64 key that opens this project's values; write it with `sikrets env pull --project-key` |

Or explicitly: `createSikrets({ project: "shop", ttlMs: 60_000 })`. Once a project is migrated (`"encryption": "required"` in sikrets.json), the SDK refuses a plaintext value planted in SSM, like the CLI. Where sikrets.json isn't deployed, pass `requireEncrypted: true`.

## Production permissions (ssm vault)

Give the app's IAM role read access to its own project only:

```json
{
  "Effect": "Allow",
  "Action": "ssm:GetParameter",
  "Resource": "arn:aws:ssm:*:<account-id>:parameter/sikrets/<project>/*"
}
```

plus `kms:Decrypt` on the key that encrypts those parameters (the AWS-managed `aws/ssm` key by default), and `SIKRETS_PROJECT_KEY` in the app's environment. IAM gets the app the ciphertext; only the project key opens it. That key opens this one project, never your others. On AWS (Lambda, ECS, EC2) the role is attached to the workload, so there's no credential to store. On platforms without that, the app needs a read-only credential scoped as above.
