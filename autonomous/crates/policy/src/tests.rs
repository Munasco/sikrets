use super::*;

const POLICY: &str = r#"{
  "resources": {
    "eth-hot-wallet": {
      "allow": ["transfer", "sign"],
      "requires_grant": true,
      "destinations": ["cold-eth", "user-withdrawals"],
      "approval_over": "$5m",
      "ceilings": [{ "window": "10m", "max": "$20m" }],
      "freeze_for": "1h"
    },
    "docs-bucket": { "allow": ["read", "write"], "min_posture": "unknown" }
  }
}"#;

const MIN: Millis = 60_000;

struct Fixture {
    e: Engine,
    svc: PrincipalId,
    laptop: DeviceId,
    wallet: ResourceId,
    cold: DestinationId,
    grant: GrantId,
}

fn fixture() -> Fixture {
    let mut e = Engine::from_json(POLICY).unwrap();
    let svc = e.principal("svc-withdrawal");
    let laptop = e.device("ops-laptop");
    e.set_posture(laptop, Posture::Healthy);
    let wallet = e.resource("eth-hot-wallet").unwrap();
    let cold = e.destination("cold-eth");
    let grant = e.grant(svc, wallet, Kinds::of(&[Kind::Transfer]), 45 * MIN);
    Fixture { e, svc, laptop, wallet, cold, grant }
}

fn transfer(f: &Fixture, at: Millis, dollars: u64, to: DestinationId) -> Action {
    Action {
        at,
        usd_cents: dollars * 100,
        principal: f.svc,
        device: f.laptop,
        resource: f.wallet,
        destination: Some(to),
        grant: Some(f.grant),
        kind: Kind::Transfer,
    }
}

#[test]
fn allows_a_granted_transfer_to_an_allowed_destination() {
    let mut f = fixture();
    let a = transfer(&f, MIN, 1_000_000, f.cold);
    assert_eq!(f.e.evaluate(&a), Decision::Allow);
}

#[test]
fn denies_delegation_outright() {
    // EIP-7702: the Binance ETH hot wallet signed 50 delegations to the attacker's sweeper.
    let mut f = fixture();
    let sweeper = f.e.destination("attacker-sweeper");
    let a = Action { kind: Kind::Delegate, usd_cents: 0, ..transfer(&f, MIN, 0, sweeper) };
    assert_eq!(f.e.evaluate(&a), Decision::Deny(Reason::KindNotAllowed));
}

#[test]
fn denies_unknown_destinations() {
    let mut f = fixture();
    let attacker = f.e.destination("attacker-1");
    assert_eq!(f.e.evaluate(&transfer(&f, MIN, 10, attacker)), Decision::Deny(Reason::DestinationNotAllowed));
    let none = Action { destination: None, ..transfer(&f, MIN, 10, f.cold) };
    assert_eq!(f.e.evaluate(&none), Decision::Deny(Reason::DestinationNotAllowed));
}

#[test]
fn grants_are_required_scoped_and_expire() {
    let mut f = fixture();
    let standing = Action { grant: None, ..transfer(&f, MIN, 10, f.cold) };
    assert_eq!(f.e.evaluate(&standing), Decision::Deny(Reason::NoGrant));

    let late = transfer(&f, 45 * MIN, 10, f.cold);
    assert_eq!(f.e.evaluate(&late), Decision::Deny(Reason::GrantExpired));

    let other = f.e.principal("someone-else");
    let stolen = Action { principal: other, ..transfer(&f, MIN, 10, f.cold) };
    assert_eq!(f.e.evaluate(&stolen), Decision::Deny(Reason::GrantMismatch));

    let sign = Action { kind: Kind::Sign, ..transfer(&f, MIN, 0, f.cold) };
    assert_eq!(f.e.evaluate(&sign), Decision::Deny(Reason::GrantMismatch), "grant covers transfer only");

    assert!(f.e.revoke(f.grant));
    assert!(!f.e.revoke(f.grant), "second revoke reports nothing changed");
    assert_eq!(f.e.evaluate(&transfer(&f, MIN, 10, f.cold)), Decision::Deny(Reason::GrantRevoked));
}

#[test]
fn unhealthy_devices_are_denied() {
    let mut f = fixture();
    f.e.set_posture(f.laptop, Posture::Suspicious);
    assert_eq!(f.e.evaluate(&transfer(&f, MIN, 10, f.cold)), Decision::Deny(Reason::DevicePosture));
    let unseen = Action { device: DeviceId(99), ..transfer(&f, MIN, 10, f.cold) };
    assert_eq!(f.e.evaluate(&unseen), Decision::Deny(Reason::DevicePosture), "unknown posture fails healthy-only");
}

#[test]
fn large_actions_wait_for_a_human() {
    let mut f = fixture();
    let big = transfer(&f, MIN, 6_000_000, f.cold);
    assert_eq!(f.e.evaluate(&big), Decision::Escalate(Reason::NeedsApproval));
    assert_eq!(f.e.evaluate_approved(&big), Decision::Allow);
}

#[test]
fn a_burst_trips_the_ceiling_and_freezes() {
    let mut f = fixture();
    let mut allowed = 0u64;
    let mut first_denial = None;
    for i in 0..10 {
        let a = transfer(&f, MIN + i * 1_000, 4_000_000, f.cold);
        match f.e.evaluate(&a) {
            Decision::Allow => allowed += 4_000_000,
            d => {
                first_denial.get_or_insert(d);
            }
        }
    }
    assert_eq!(allowed, 20_000_000, "exactly the $20m ceiling gets out");
    assert_eq!(first_denial, Some(Decision::Deny(Reason::CeilingExceeded)));
    // Frozen for an hour, even for a small, otherwise fine transfer.
    assert_eq!(f.e.evaluate(&transfer(&f, 30 * MIN, 1, f.cold)), Decision::Deny(Reason::Frozen));
    f.e.unfreeze(f.wallet);
    assert_eq!(f.e.evaluate(&transfer(&f, 30 * MIN, 1, f.cold)), Decision::Allow);
}

#[test]
fn rejects_bad_policy() {
    let bad = r#"{"resources":{"x":{"allow":["read"],"ceilings":[{"window":"soon","max":"$1"}]}}}"#;
    assert!(Engine::from_json(bad).is_err());
    let typo = r#"{"resources":{"x":{"allow":["read"],"requires_grants":true}}}"#;
    assert!(Engine::from_json(typo).is_err(), "unknown fields are errors, not silently ignored");
}
