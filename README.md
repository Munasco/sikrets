<h1 align="center">Sikrets</h1>

<p align="center"><b>The security platform for the agent era.</b> Secure every API key your agents and apps use, without ever handing them over.</p>

<h4 align="center">
  <a href="https://sikrets.usetennant.com">Website</a> |
  <a href="https://usetennant.com/waitlist">Sikrets Cloud</a> |
  <a href="https://x.com/tennantcloud">X</a>
</h4>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Sikrets is released under the MIT license." /></a>
</p>

## Introduction

Sikrets creates, keeps and rotates the API keys your projects use. Your `.env`, CI and hosting hold **stand-ins** (`sk-sikrets-…`) that open nothing on their own; the real keys stay in one vault. Agents run commands through `sikrets run` and use keys without ever seeing them.

## Features

- **Stand-ins**: a leaked `.env` or CI log exposes placeholders, not keys.
- **Provisioning**: `sikrets add upstash/redis` creates the resource and its keys. Keys made in a dashboard are pasted once, verified and stored.
- **Rotation**: replace a key without touching the stand-ins, so nothing needs redeploying.
- **Dry run and rollback**: preview every change and its cost, then undo an add step by step.
- **Built for agents**: `sikrets run -- <command>` injects keys for that command only. Output, errors and `--json` never contain values.
- **Status, activity and cost**: every key, when it was last used, who did what, and what it costs.
- **SDK**: [`@sikrets/sdk`](packages/sdk) resolves stand-ins to real values at runtime.

## Getting started

Requires [Bun](https://bun.sh) 1.3 or later.

```console
git clone https://github.com/Munasco/sikrets && cd sikrets/packages/cli && bun install && bun link
```

Then, in your project:

```console
sikrets init --vault keychain          # or --vault ssm for AWS SSM Parameter Store
sikrets add upstash/redis --name cache --dry-run
sikrets add upstash/redis --name cache
sikrets run -- bun dev
```

`sikrets catalog` lists the services you can add, and `sikrets <command> --help` explains each command.

## Repository

| Path | |
| --- | --- |
| [`packages/cli`](packages/cli) | The `sikrets` CLI |
| [`packages/sdk`](packages/sdk) | `@sikrets/sdk`, the runtime client |
| [`app`](app) | The website, [sikrets.usetennant.com](https://sikrets.usetennant.com) |

## Contributing

```console
cd packages/cli && bun install && bun test
```

Found a security issue? Please [report it privately](https://github.com/Munasco/sikrets/security/advisories/new) instead of opening an issue.

## License

[MIT](LICENSE). A [Tennant](https://usetennant.com) product.
