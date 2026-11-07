//! cargo bench -p sikrets-audit

use divan::{Bencher, black_box};
use sikrets_audit::{Ledger, generate_key};
use sikrets_core::*;

fn main() {
    divan::main();
}

fn action(i: u64) -> Action {
    Action {
        at: i,
        usd_cents: i,
        principal: PrincipalId(1),
        device: DeviceId(2),
        resource: ResourceId((i % 64) as u32),
        destination: Some(DestinationId(3)),
        grant: Some(GrantId(4)),
        kind: Kind::Transfer,
    }
}

/// One decision appended to the chain (buffered, no fsync): encode + BLAKE3 + copy.
#[divan::bench]
fn record(b: Bencher) {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Ledger::open(&dir.path().join("l.bin"), generate_key()).unwrap();
    let mut i = 0u64;
    b.bench_local(|| {
        i += 1;
        black_box(l.record(black_box(&action(i)), Decision::Allow).unwrap())
    });
}

/// A signed checkpoint (Ed25519 sign + frame).
#[divan::bench]
fn checkpoint(b: Bencher) {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Ledger::open(&dir.path().join("l.bin"), generate_key()).unwrap();
    b.bench_local(|| l.checkpoint().unwrap());
}

/// Group commit: 1,024 decisions, one checkpoint, one fsync.
#[divan::bench(sample_count = 30)]
fn group_commit_1024(b: Bencher) {
    let dir = tempfile::tempdir().unwrap();
    let mut l = Ledger::open(&dir.path().join("l.bin"), generate_key()).unwrap();
    let mut i = 0u64;
    b.counter(divan::counter::ItemsCount::new(1_024usize)).bench_local(|| {
        for _ in 0..1_024 {
            i += 1;
            l.record(&action(i), Decision::Allow).unwrap();
        }
        l.checkpoint().unwrap();
        l.sync().unwrap();
    });
}
