---
name: Supply-chain audit
description: Audit a project's dependencies for known vulnerabilities and install-time code (npm install hooks, Cargo build.rs, git and URL dependencies). Use when asked whether a repo or package is safe to install or build.
---
# Supply-chain audit

Goal: tell the user what in their dependency tree can run code on their machine or CI, and what has known vulnerabilities, without ever running that code yourself.

## Rules

- Never install or build: no `npm install`, `pnpm install`, `yarn`, `bun install`, `cargo build`, `cargo test`, `pip install`. They run install scripts and `build.rs`, which is the thing you're auditing.
- Read-only commands only: `git clone --depth 1`, `npm audit --package-lock-only`, `cargo audit`, `grep`, reading files.
- If a tool isn't installed (`command -v cargo-audit`), say so and fall back to `osv_lookup`. Don't install it.

## Steps

1. **Get the code.** For a public GitHub repo, `git clone --depth 1 https://github.com/<owner>/<repo> audit/<repo>` with the shell tool. For a pasted manifest or lockfile, work from the text.
2. **Inventory.** Glob for `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `.npmrc`, `Cargo.toml`, `Cargo.lock`, `build.rs`, `pyproject.toml`, `requirements*.txt`, `go.mod`. No lockfile is itself a finding: versions float.
3. **Known vulnerabilities.**
   - npm: `npm audit --json --package-lock-only` in each folder with a `package-lock.json`.
   - Rust: `cargo audit --json` where there's a `Cargo.lock`.
   - Anything else, or when those tools are missing: `osv_lookup` for each direct dependency at its locked version.
4. **Install-time code (npm and friends).**
   - The project's own `scripts`: `preinstall`, `install`, `postinstall`, `prepare`.
   - Dependencies that run scripts: `"hasInstallScript": true` in `package-lock.json`, `requiresBuild: true` in `pnpm-lock.yaml`, `trustedDependencies` in `package.json` (Bun).
   - For each, name the package and why it needs a script (native build, binary download). A download over plain HTTP, `curl … | sh`, or `node -e` with encoded strings is a red flag.
5. **Build-time code (Rust).**
   - Every `build.rs` in the repo and in vendored crates (`vendor/`), plus `[build-dependencies]` and proc-macro crates (`proc-macro = true`).
   - Read each `build.rs`. Flag network access (`reqwest`, `ureq`, `curl`, `TcpStream`), `std::process::Command`, reads of env vars that hold secrets, and writes outside `OUT_DIR`.
6. **Where dependencies come from.** Git, URL, tarball or path dependencies (`git+`, `https://` in lockfiles; `git =` in `Cargo.toml`), custom registries in `.npmrc` or `.cargo/config.toml`, and names one typo away from a popular package.
7. **Secrets.** `scan_github_repo` on the repo: a leaked publish token is a supply-chain risk too.

## Report

Lead with the verdict: safe to install, install with care, or don't. Then a short table, worst first:

| Risk | What | Where | Fix |
|---|---|---|---|

Fixes are concrete: the version to upgrade to, `npm install --ignore-scripts` with an allowlist, `cargo vet` or vendoring, replacing a git dependency with a registry release.
