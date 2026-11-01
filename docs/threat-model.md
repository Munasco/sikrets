# Sikrets threat model

What Sikrets protects, from whom, where the trust boundaries are, and what is still weak. It covers
what ships today and what is designed but not built; each part says which.

Sikrets is open source. The CLI, the SDK, the enclave code and the authority rules (who may do what,
for how long) are public, and this document assumes attackers have read them. Detection triggers
and rotation history are not public and are not described here.

## Status

| Part | Status |
| --- | --- |
| CLI, OS keychain vault, SSM vault, stand-ins, activity log | Shipped |
| Signed, checksummed, attested release binaries | Shipped with this document |
| Hosted zero-knowledge storage on AWS | Designed, not built |
| Nitro Enclave agent with KMS attestation | Designed, not built |
| Gateway (holds real keys, lends their use) | Designed, not built |

## Assets

- **Provider credentials**: the real API keys and tokens Sikrets provisions, stores and rotates.
- **Provider admin credentials**: management keys and logins Sikrets uses to mint the above. One
  of these is worth more than any single key it creates.
- **Browser sessions** from `sikrets connect`: persistent provider logins in `~/.sikrets/browser`.
- **Vault encryption keys**: the user's device keys (hosted storage) and the KMS keys behind SSM
  and the enclave.
- **Authority**: grants that let an agent or workload use a credential, and the policy deciding them.
- **The audit trail**: what happened, who did it, which key names were involved.
- **The release pipeline**: the binary everyone runs.

## Actors

- **The user** on their own machine. Trusted.
- **Teammates** sharing an SSM vault or, later, a workspace. Trusted for their grants only.
- **Agents and MCP clients**: coding agents, MCP servers, CI jobs, sandboxes. Not trusted. They act
  for the user but read untrusted input (web pages, issues, dependencies) and can be steered by it.
- **Third-party platforms** that run the user's code (hosting, CI). Not trusted with real keys.
- **Sikrets operators**, including insiders with AWS access. Not trusted with plaintext.
- **External attackers**: malware on the device, malicious packages, network attackers, anyone who
  steals a repo, `.env` file, backup or log.

## Trust boundaries

```
 device ─────────────────────┐    AWS (Sikrets) ──────────────────────────────┐
 │ CLI ── OS keychain        │    │ storage (ciphertext only)                  │
 │  │                        │ ─► │ gateway ──► enclave agent ──► KMS          │
 │  └── sikrets run ─► child │    │              (attested)                    │
 │ agents / MCP clients      │    └────────────────────────────────────────────┘
 └───────────────────────────┘          │
        provider APIs ◄─────────────────┘
```

1. Device ↔ agents and child processes: an agent on the same machine runs as the same OS user.
2. Device ↔ Sikrets cloud: only ciphertext crosses, plus requests the gateway authorizes.
3. Gateway ↔ enclave: the gateway routes; only the attested enclave can decrypt.
4. Sikrets ↔ providers: provider APIs see real keys; that is unavoidable.
5. Source ↔ binary: what users run must be what this repo built.

## Local CLI and keychain (shipped)

**Threats**

- A key leaks through the project: committed `.env`, logs, crash dumps, shell history, agent chat.
- Malware or a malicious package running as the user reads the keychain or `~/.sikrets`.
- An agent runs `sikrets env pull --real` or `sikrets run -- printenv` and reads the values.
- A stolen laptop exposes stored logins.

**Mitigations**

- Projects hold stand-ins (`sk-sikrets-…`), not keys. Stand-ins are useless against providers, so a
  leaked `.env` or repo exposes nothing on its own. Real values only reach a child process through
  `sikrets run`, which writes nothing to disk.
- Values travel inside `Secret`, which never renders in strings, JSON or logs.
- Real keys sit in the OS keychain (encrypted at rest, tied to the user's login) or in SSM.
- `~/.sikrets` files are `0600` in `0700` folders. The activity log records key names, never values.
- `env pull --real` is opt-in and writes a mode-600, git-ignored file.

**Gaps**

- Anything running as the user can do what the user can. The keychain does not tell the CLI apart
  from malware that calls it, and `sikrets run -- <anything>` hands values to whatever it runs.
  Nothing yet asks for a fresh unlock before `--real` or before injecting values.
- Saved browser sessions in `~/.sikrets/browser` are protected only by file permissions.
- Provider admin credentials are stored on the device with the same protection as everything else.
- The activity log is a plain local file. Anyone with write access can edit it.

## Storage and SSM (SSM shipped, hosted storage designed)

**Threats**

- An operator, insider or attacker with AWS access reads stored secrets.
- A database or backup leak.
- A team member's IAM access is broader than it should be (SSM).
- Ciphertext is swapped or rolled back to an older value.

**Mitigations**

- SSM: SecureString parameters under `/sikrets/<project>/`, encrypted with KMS, gated by IAM. The
  SDK README lists the narrow read policy an app needs.
- Hosted storage (designed): values are encrypted on the device before upload, with keys the user
  holds. Sikrets stores ciphertext and metadata it cannot read. A leak of the store leaks ciphertext.
- Designed: hosted storage binds each ciphertext to its project, key name and version, so a swapped or replayed
  blob fails to decrypt.

**Gaps**

- SSM is not zero-knowledge. Anyone with `ssm:GetParameter` and `kms:Decrypt` on that account can
  read values, including account admins.
- Hosted storage is not built. Until it is independently reviewed, don't rely on the zero-knowledge
  claim.
- Metadata is visible to Sikrets: project names, key names, sizes, timing, who accessed what.
- Device-key recovery is undecided. Losing every device may mean losing the vault.

## Enclave agent and KMS attestation (designed)

The enclave is where real keys are used, so the rest of Sikrets never needs them in plaintext. It
runs in an AWS Nitro Enclave: no network, no disk, no interactive access. KMS releases the data key
only to an enclave whose attestation document matches the published image measurement (PCRs).

**Threats**

- A modified enclave image that exfiltrates keys.
- The parent instance (which Sikrets operators control) tampers with traffic into the enclave.
- Bugs in the enclave code itself.
- Rollback to an older, vulnerable enclave image.

**Mitigations**

- The KMS key policy allows decrypt only with an attestation whose PCRs match the reproducibly built,
  published image. A changed image gets no keys. Changing the key policy is logged in CloudTrail.
- Requests into the enclave are authenticated end to end, so the parent can drop or delay them but
  not forge or alter them.
- The enclave enforces the public authority rules itself; the gateway's word is not enough.
- The enclave code is public and small on purpose.

**Gaps**

- Nitro trusts AWS: the hypervisor, the Nitro hardware, KMS. A compromised or compelled AWS is out of
  scope.
- An operator can change the KMS key policy to accept a new image. That is visible in CloudTrail and
  in the published measurements, but it is detection after the fact, not prevention.
- Reproducible builds and an external audit of the enclave are not done yet.
- The enclave can be denied service by its parent.

## Agents and MCP clients

**Threats**

- Prompt injection steers an agent into reading, printing or sending a key.
- A malicious or compromised MCP server asks for more than its task needs.
- An agent keeps access after the task ends.
- An agent pastes a real key into a third-party tool or chat.

**Mitigations**

- Agents get stand-ins and env var names, never literal keys. `sikrets run` gives a child process the
  values without the agent seeing them in its context.
- The CLI's `--json` output never contains values.
- Designed: grants are narrow (one credential, one scope), time-limited and revocable, and every use
  is logged. Deterministic policy decides grants; a model never does.

**Gaps**

- Today, an agent that can run shell commands as the user can call `sikrets run -- printenv` or read
  the keychain. Stand-ins reduce casual leaks; they do not stop a determined agent on the same
  account. Only the gateway closes this.
- MCP clients have no Sikrets-specific identity yet.

## Gateway (designed)

The gateway takes requests from workloads that hold stand-ins, checks the caller's identity and
grant, and has the enclave make the provider call with the real key. The real key never leaves.

**Threats**

- A stolen stand-in used from somewhere else.
- A workload spoofs another workload's identity.
- Abuse of a valid grant: too many calls, the wrong endpoints, unusual spend.
- The gateway as a single point of failure.

**Mitigations**

- A stand-in alone is not enough. Callers also prove workload identity (cloud IAM role, OIDC token
  such as GitHub Actions, see [keyless-ci.md](keyless-ci.md)), and grants are bound to that identity.
- Grants carry scope, expiry and rate limits, and can be revoked at once.
- Every request is logged with the caller, the grant and the key name.

**Gaps**

- Platforms without signed workload identity (e.g. some hosting providers) can only present a
  stored credential, which can be stolen like any other.
- Provider requests and responses pass through Sikrets. Bodies are not logged, but the gateway and
  enclave handle them in plaintext.
- An outage blocks every call that depends on it. Offline behaviour is undecided.

## Releases and updates (shipped)

**Threats**

- A tampered binary on the download path or in the release.
- A compromised CI workflow, action or maintainer account.
- `curl | sh` from a hijacked site.

**Mitigations**

- `install.sh` and `sikrets update` check every binary against the release's `SHA256SUMS` and refuse a
  mismatch; `update` swaps the binary with a rename, so a failure leaves the old one in place.
- Binaries carry GitHub build provenance: `gh attestation verify <file> --repo Munasco/sikrets`.
- macOS builds are signed with a Developer ID and notarized (once the Apple secrets are set).
- Releases build only from `v*` tags, with the job token scoped per job.

**Gaps**

- `SHA256SUMS` comes from the same release as the binary. It catches corruption and mirror tampering,
  not a compromised release. `install.sh` and `update` don't verify the attestation yet.
- Third-party actions are pinned by tag, not commit SHA.
- Windows and Linux binaries are not code-signed.
- The install script is served by the website. Whoever controls the site controls what `curl | sh`
  runs.

## Out of scope

- A fully compromised device, OS or user account.
- Providers' own security, and keys that providers leak.
- AWS itself acting maliciously.
- Denial of service against Sikrets cloud.

## Reporting

Report vulnerabilities privately through GitHub security advisories on this repo, not public issues.
