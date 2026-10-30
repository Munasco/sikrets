//! cargo bench -p sikrets-policy

use divan::{Bencher, black_box};
use sikrets_core::*;
use sikrets_policy::Engine;

fn main() {
    divan::main();
}

/// 1,000 resources, 256 allowlisted destinations each, two ceilings: bigger than a real exchange's
/// hot-wallet set, so the numbers are an upper bound.
fn engine() -> (Engine, Vec<Action>) {
    let mut resources = String::new();
    for r in 0..1_000 {
        let dests: Vec<String> = (0..256).map(|d| format!("\"d{}\"", (r * 7 + d) % 4_096)).collect();
        resources.push_str(&format!(
            r#"{}"r{r}": {{"allow":["transfer","read"],"requires_grant":true,"destinations":[{}],
               "approval_over":"$5m","ceilings":[{{"window":"10m","max":"$1b"}},{{"window":"24h","max":"$10b"}}]}}"#,
            if r == 0 { "" } else { "," },
            dests.join(",")
        ));
    }
    let mut e = Engine::from_json(&format!(r#"{{"resources":{{{resources}}}}}"#)).unwrap();
    let svc = e.principal("svc");
    let dev = e.device("laptop");
    e.set_posture(dev, Posture::Healthy);
    let mut actions = Vec::with_capacity(4_096);
    let mut x = 0x2545F4914F6CDD1Du64;
    for i in 0..4_096u64 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let n = x % 1_000;
        let r = e.resource(&format!("r{n}")).unwrap();
        let g = e.grant(svc, r, Kinds::of(&[Kind::Transfer]), u64::MAX);
        let d = e.destination(&format!("d{}", (n * 7 + x % 256) % 4_096));
        actions.push(Action {
            at: i * 50,
            usd_cents: 1 + x % 100_000,
            principal: svc,
            device: dev,
            resource: r,
            destination: Some(d),
            grant: Some(g),
            kind: Kind::Transfer,
        });
    }
    // The benchmark must measure the allow path, not cheap early denials.
    let allowed = actions.iter().filter(|a| e.evaluate(a).allowed()).count();
    assert_eq!(allowed, actions.len(), "every benchmark action should be allowed");
    (e, actions)
}

/// Full path: every check passes and both windows are updated.
#[divan::bench]
fn allow_full_path(b: Bencher) {
    let (mut e, actions) = engine();
    let mut i = 0usize;
    b.bench_local(|| {
        let a = &actions[i & 4_095];
        i = i.wrapping_add(1);
        black_box(e.evaluate(black_box(a)))
    });
}

/// Early exit: delegation is never allowed (the Binance EIP-7702 case).
#[divan::bench]
fn deny_delegate(b: Bencher) {
    let (mut e, actions) = engine();
    let mut i = 0usize;
    b.bench_local(|| {
        let a = Action { kind: Kind::Delegate, ..actions[i & 4_095] };
        i = i.wrapping_add(1);
        black_box(e.evaluate(black_box(&a)))
    });
}

/// Throughput: decisions per second on one core over the whole batch.
#[divan::bench]
fn batch_4096(b: Bencher) {
    let (mut e, actions) = engine();
    b.counter(divan::counter::ItemsCount::new(actions.len())).bench_local(|| {
        for a in &actions {
            black_box(e.evaluate(a));
        }
    });
}
