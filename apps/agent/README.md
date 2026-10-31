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

## Hosting

`deploy/aws.sh` sets up us-east-1: a Graviton instance (c7g.xlarge, IMDSv2, SSM only, no SSH) with Nitro Enclaves enabled, reachable only from CloudFront, which serves HTTPS. The instance role can call only the agent's Bedrock models and read its access code from SSM. The access code is generated once and also saved to your macOS keychain:

```sh
security find-generic-password -s sikrets-agent-demo -a access-code -w
```

`deploy/enclave/host.sh up` (on the instance) runs the agent inside the Nitro Enclave:

- **Isolation:** the host can't read the enclave's memory. It only relays encrypted bytes: TLS to Bedrock, GitHub and OSV runs from inside the enclave, through vsock proxies allowed to reach just those three hosts.
- **Credentials:** the host hands the enclave the role's short-lived credentials every 15 minutes.
- **Attestation:** `/attestation` returns a document signed by the Nitro Security Module. Its PCR0–2 must match the measurements `nitro-cli build-enclave` printed for this build.

`host.sh down` serves from the host again.
