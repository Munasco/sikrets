# Keyless CI with GitHub Actions OIDC

Status: design. Nothing here is built yet.

## Goal

A GitHub Actions job gets the credentials it needs for that one run, without any long-lived secret
stored in the repo or org settings. Access ends when the job does, and every use is tied to a
specific repo, workflow and ref.

## How it works

GitHub can issue each job a signed OIDC token (a JWT) when the workflow has
`permissions: id-token: write`. Its claims say exactly who is asking: `repository`, `repository_id`,
`repository_owner_id`, `ref`, `environment`, `workflow_ref`, `job_workflow_ref`, `event_name`, `sha`.
GitHub signs it; anyone can check the signature against GitHub's published keys.

```
job ──(1) request OIDC token, aud=sikrets──► GitHub
job ──(2) token ──────────────────────────► Sikrets gateway
                                              (3) verify signature, issuer, audience, expiry
                                              (4) match claims against the project's trust rules
job ◄─(5) short-lived grant (≤ job length) ── gateway
job ──(6) sikrets run -- <build/deploy> ────► values or proxied calls, logged against the run
```

1. The job asks GitHub for a token with audience `sikrets` (so it can't be replayed at another
   service, and other services' tokens can't be replayed here).
2. The CLI sends it to the gateway.
3. The gateway checks the signature against GitHub's JWKS, issuer
   `https://token.actions.githubusercontent.com`, audience, and expiry.
4. The gateway matches the claims against the project's trust rules (below). No match, no access.
5. It returns a grant scoped to the keys the rule allows, expiring when the job's token does (or
   sooner). Nothing is written to the runner's disk.
6. The job uses it through `sikrets run`. Each use is logged with the run ID and commit SHA.

## Trust rules

Rules live in the hosted project, not in the repo, so a pull request can't widen its own access.

```json
{
  "github": [
    {
      "repository": "acme/shop",
      "repository_id": "7654321",
      "repository_owner_id": "1234567",
      "ref": "refs/heads/main",
      "environment": "production",
      "keys": ["STRIPE_SECRET_KEY", "DATABASE_URL"]
    },
    {
      "repository": "acme/shop",
      "event_name": "pull_request",
      "keys": ["STRIPE_TEST_KEY"]
    }
  ]
}
```

- Match on `repository_id` and `repository_owner_id`, not only names, so a deleted and re-created repo or
  org with the same name doesn't inherit access.
- Production keys require `environment`, so GitHub's environment protection rules (reviewers,
  branch limits) apply before the token is even issued.
- `pull_request` from forks gets nothing by default.
- Pin `job_workflow_ref` when the rule should only trust a specific reusable workflow.

## In a workflow

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: curl -fsSL https://sikrets.usetennant.com/install.sh | sh
      - run: sikrets run -- ./deploy.sh
```

The CLI notices `ACTIONS_ID_TOKEN_REQUEST_URL` and does steps 1–5 itself. No `secrets.*` anywhere.

## Today, with the SSM vault

The same idea already works for projects on the SSM vault, using AWS instead of the gateway: an IAM
role trusts GitHub's OIDC provider with a condition on `sub` (repo, ref or environment), and
`aws-actions/configure-aws-credentials` assumes it. Grant that role only the read policy in
`packages/sdk/README.md`, scoped to `/sikrets/<project>/*`.

## Risks

- A rule that's too broad (`repository` only, any ref) lets any branch or workflow in the repo read
  production keys. The CLI should warn on rules without `ref` or `environment`.
- Anyone who can push to a trusted ref can run code with those keys. Pair with branch protection.
- In proxy mode the job never sees the real key; in value mode it does, for the length of the job,
  and a malicious step can copy it. Prefer proxy mode where the provider allows it.
- GitHub is trusted to issue honest tokens.
