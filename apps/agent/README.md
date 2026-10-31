# Sikrets security agent

Chat with an agent that finds leaked keys and walks you through fixing them.

- **scan_text**: finds credentials in pasted code or config.
- **scan_github_repo**: scans a public repo's latest commit.
- **check_leak_hashes**: checks leak notices that give SHA-256 hashes, without needing the keys.
- **how_to_rotate**: where to revoke and reissue a key, for 3,000+ services in the Sikrets catalog.
- **osv_lookup**: known vulnerabilities for a package.

Keys you paste are swapped for placeholders before the model sees them; tools get the real values on the server and return only redacted findings (prefix…last4 and a SHA-256).

```sh
cd apps/agent
bun install
bun start          # http://127.0.0.1:8787, uses your AWS credentials for Bedrock
bun test
```

| Env | Default |
|---|---|
| `MODEL_ID` | `openai.gpt-oss-120b-1:0` (Bedrock) |
| `MODEL_FALLBACK` | `openai.gpt-oss-20b-1:0` |
| `BEDROCK_REGION` | `us-east-1` |
| `ACCESS_CODE` | unset: open. Set: the page asks for it. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` |

`deploy/` holds the AWS setup: a Graviton instance with Nitro Enclaves enabled, behind CloudFront.
