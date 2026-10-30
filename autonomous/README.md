# Sikrets Autonomous

The proactive layer of Sikrets, in Rust. It finds attack paths before attackers do, puts a deterministic gate in front of every consequential action, and keeps tamper-evident evidence of every decision. Models explain and propose; they never decide.

```console
cargo build --release
./target/release/sikrets-auto scan scenarios/binance-2026-10-29/graph.json
./target/release/sikrets-auto replay scenarios/binance-2026-10-29
```

## The Binance case

On 29 October 2026 about $6.36B left Binance hot wallets on ten chains, most of it within about 20 minutes. Binance says a compromised DevOps engineer's laptop reached a service container that submitted withdrawals. No private key leaked: the attacker didn't need a key, only a trusted machine that was allowed to ask.

**Before the attack**, `scan` finds that path:

```
✗ 2 of 6 entry points can reach a critical action through standing access alone.

CRITICAL  devops-laptop → withdrawal-service → hot-wallet-signer → 11 critical resources  (transfer, sign)
          fix: Require a time-limited grant for hot-wallet-signer → 11 critical resources (signs any transaction),
               and for devops-laptop → withdrawal-service (kubectl exec into the service container).
```

**During the attack**, `replay` runs TRM Labs' public timeline through the gateway, assuming more goes wrong at each layer:

| Layer | Lost |
| --- | --- |
| As it was: the signer signs whatever the service asks | $6.36B |
| Sikrets: standing access replaced by grants | $0 |
| …the attacker hijacks a live 45-minute grant from a healthy-looking device | $0 |
| …the grant is renewed all night, the attacker owns an allowlisted address and splits transfers under $5m | $99.8M |

The 50 EIP-7702 delegations are refused outright (`delegate` is never allowed on a hot wallet), so the $3.3B of sweeps that depended on them never happen. In the last layer each wallet freezes for 24 hours once it hits its $10m ceiling.

The internal architecture in `scenarios/` is illustrative, built from public reporting. USD values are approximate. This is a scenario, not a claim about what would have happened at Binance.

## Pieces

| Crate | |
| --- | --- |
| `crates/core` | Interned ids and 48-byte `Action`s: nothing on the hot path allocates |
| `crates/policy` | The deterministic engine: kind, grant, device posture, destination allowlist, approval threshold and rolling value ceilings that freeze a resource on breach |
| `crates/audit` | Append-only ledger: BLAKE3-keyed hash chain, Ed25519-signed checkpoints, self-describing names |
| `crates/scan` | Proactive exposure scan: every standing path from a compromisable entry point to a value-moving action, in one reverse BFS |
| `crates/triage` | Model triage behind a `Reasoner` trait (Gemini today). Schema-constrained output, proposals from a fixed action list, invented targets dropped, falls back to deterministic fixes when the model is down |
| `services/gateway` | HTTP gateway: `POST /v1/decide`, grants, revocation, device posture, ledger head. An `allow` returns only after its ledger entry is on disk |
| `services/cli` | `sikrets-auto scan`, `replay`, `ledger verify`, `ledger show` |

## Performance

Apple M3 Pro, release build. Benchmarks: `cargo bench`.

| | |
| --- | --- |
| Policy decision, every check passes, two windows updated | 9.4 ns (106M/s per core) |
| Policy decision, delegation denied | 3 ns |
| Ledger append (encode + hash chain) | 83 ns |
| Signed checkpoint | 10.7 µs |
| Scan, 58k nodes / 210k edges | 1.5 ms |
| Gateway over HTTP, deny path, 64 connections | 187k req/s, p50 0.27 ms, p99 1.8 ms |
| Gateway over HTTP, allow path (waits for fsync) | 17k req/s, p50 3.2 ms; bound by macOS `F_FULLFSYNC` |

Two of these came from profiling with [samply](https://github.com/mstange/samply): chaining with the previous hash as the BLAKE3 key fits a decision frame into one compression (202 → 83 ns), and resolving graph names once instead of per scan removed a 74% `memcmp` hotspot (43 → 1.5 ms).

## Gateway

```console
SIKRETS_POLICY=scenarios/binance-2026-10-29/policy.json SIKRETS_ADMIN_TOKEN=… ./target/release/sikrets-gateway

curl localhost:7878/v1/decide -d '{"principal":"withdrawal-service","device":"devops-laptop",
  "resource":"btc-hot-wallet","kind":"transfer","destination":"attacker-btc","usd_cents":100}'
{"decision":"deny","reason":"no_grant","detail":"no access grant; standing access is not allowed here","seq":0}
```

Admin routes (grants, revocation, device posture) need `SIKRETS_ADMIN_TOKEN` and are off without it. The ledger key is created on first start (`data/ledger.key`, mode 0600); `ledger.pub` verifies it.

## Model triage

`sikrets-auto scan … --triage` sends the scan (names and structure, never secret values) to `gemini-4-argon` with `GEMINI_API_KEY`. Override the model with `SIKRETS_MODEL`. Live test: `cargo test -p sikrets-triage -- --ignored`.

## Not yet

- The gateway is single-node with one lock; sharding by resource is the path to multi-core scaling.
- Grants are issued by an admin token, not by a policy-checked request flow with human approval.
- The ledger key sits on disk; it belongs in a KMS or an attested enclave.
- No endpoint sensor yet: device posture is reported to the gateway, not measured.
