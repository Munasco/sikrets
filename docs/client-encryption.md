# Client-side encryption and backups

Values bound for AWS SSM are encrypted on your machine before they leave it. SSM still stores them
as SecureStrings, so KMS stays on as a second layer, but whoever controls the AWS account now sees
ciphertext only.

## Keys

```
data key (256-bit, OS keychain, one per person)       ← recovery code wraps this (sikrets recovery)
  └─ HKDF-SHA256(salt "sikrets-project-key", info "sikrets-project-v1|<project>")
       └─ project key                                  ← SIKRETS_PROJECT_KEY for deployed apps
            └─ AES-256-GCM per value, AAD = "sikrets-value-v1|/sikrets/<project>/<KEY>"
```

- A deployed app holds one project key, never the data key, so a leaked deployment key opens only
  that project.
- The parameter name is the associated data. A ciphertext copied to another key or project fails to
  open.

## Envelope

```
sk1:<base64( iv[12] | ciphertext | tag[16] )>
```

- `sk1:` is the version. Anything without an `sk<n>:` prefix is legacy plaintext. A higher version
  fails with "update the CLI" instead of being misread.
- SSM Standard parameters cap at 4 KB, so the largest value is about 3 KB once sealed and encoded.

## Where values are sealed and opened

Every CLI path goes through `openVault` in `packages/cli/src/core/vault.ts`, so one place seals and
opens:

| Path | Direction |
| --- | --- |
| `sikrets add` (API and manual recipes, stand-ins) | write |
| `sikrets apply` (Terraform outputs via `core/sync.ts`) | write |
| `sikrets rotate` | write |
| `sikrets run` | read |
| `sikrets env`, `sikrets env pull [--real]` | read (stand-ins: read or write) |
| `sikrets rollback` | delete |
| `sikrets migrate encrypt`, `sikrets backup` | list, read, write |
| `@sikrets/sdk` `sikrets.get` | read, through Web Crypto in `packages/sdk/src/envelope.ts` |

The keychain vault is not encrypted by Sikrets: it never leaves the machine and the OS protects it.

## Migrating an existing project

```sh
sikrets backup create --passphrase            # a copy first, in case anything goes wrong
sikrets migrate encrypt --dry-run             # names what would change
sikrets migrate encrypt                       # seals plaintext values in place
sikrets migrate encrypt --purge-history       # drops the old plaintext from SSM's version history
sikrets recovery setup                        # if you haven't: the data key now matters
```

- Safe to re-run. Sealed values are checked and left alone, and values sealed under another key are
  reported and left untouched.
- Until a project is migrated, plaintext values are still read. When a run leaves nothing
  unreadable, `sikrets.json` gets `"encryption": "required"`, and plaintext is refused from then
  on, so a value planted in SSM can't be passed off as yours. New projects from `sikrets init` start
  with it.
- `--purge-history` deletes and recreates each parameter, because SSM keeps up to 100 old versions.
  The value is briefly missing during the swap.
- Migration doesn't undo past exposure. Anyone who could read SSM before could have copied the
  values. Rotate the keys that matter: `sikrets rotate <resource>`.

## A second device

The second device needs the same data key. Use the recovery flow:

```sh
# on the new device, with the recovery record you kept and the code you wrote down
sikrets recovery restore --file ./recovery.json
```

Until then, reads of sealed values fail with "restore it with: sikrets recovery restore". Writes
fail the same way. A new device never mints its own data key for a project that already has sealed
values, because that would split the project across two keys. The check is per project: restore
before you write to any project on a new device, or a project with no sealed values yet gets sealed
under a new key that your other devices don't have.

## Deployed apps

```sh
sikrets env pull --project-key --file .env.production   # adds SIKRETS_PROJECT and SIKRETS_PROJECT_KEY
```

Put `SIKRETS_PROJECT_KEY` in the host's secret settings. The app's IAM role still needs
`ssm:GetParameter`. `createSikrets({ requireEncrypted: true })` refuses plaintext once the project
is migrated. Under Bun on a developer machine, the SDK derives the key from the keychain, so no
setup is needed.

## Backups

```sh
sikrets backup create [file]                  # sealed with the data key (default: ~/.sikrets/backups/)
sikrets backup create file --passphrase       # Argon2id passphrase: opens on any machine
sikrets backup verify file                    # decrypts and counts, prints no values
sikrets backup restore file --dry-run         # new / changed / unchanged, by name
sikrets backup restore file
```

- A backup contains every vault value (real values and stand-ins), `.sikrets/state.json`,
  `sikrets.json`, provider links (`connections.json`) and the logins and minted API keys that
  `connect` saved to the keychain (`--no-logins` leaves them out).
- It's one AES-256-GCM box. The readable header (format, version, time, project, mode, key
  fingerprint or KDF salt) is the associated data, so editing it breaks the box.
- A data-key backup is only as recoverable as the data key. Keep a `--passphrase` copy off the
  device.
- Restore never overwrites existing resources, links or logins. It adds what's missing, and replaces
  vault values that differ.

Scheduled backups: `--dir` writes a timestamped file and `--keep N` prunes older ones (default 14).

```cron
0 3 * * *  cd ~/code/shop && sikrets backup create --dir ~/Backups/sikrets --keep 30
```

On macOS the first cron run may ask for keychain access to the data key.

## Teams (design, not built)

There are no shared projects in the code yet. Today a project is shared only by sharing an AWS
account, and a teammate can't open values sealed under your data key. The plan:

1. Each member gets an X25519 key pair. The private key sits next to the data key in the keychain
   and is wrapped by recovery. The public key is published to the project.
2. A project gets a random 256-bit project key instead of the HKDF-derived one. It's stored once
   per member, sealed to that member's public key (HPKE, X25519 + AES-256-GCM), in SSM at
   `/sikrets/<project>/.keys/<member-id>`.
3. Values become `sk2:<key-id>:<base64>`, so a rotated project key and the old one can coexist while
   values are re-sealed. `sk1:` stays readable.
4. Adding a member wraps the current project key to their public key. Removing one rotates the
   project key, re-seals every value and drops their wrap. Revocation is only real after rotating
   the provider credentials too, which `sikrets rotate` already does.
5. Public keys are pinned on first use and shown as fingerprints, so a compromised AWS account can't
   swap in its own public key unnoticed.

## Still to do

- Teams, as above.
- `requireEncrypted` in the SDK is opt-in. It could follow `sikrets.json` once deployments carry it.
- `migrate encrypt` handles one project per run (the one in the current directory).
- A crash between delete and put during `--purge-history` loses that value. Take a backup first.
