use super::*;

fn action(i: u64) -> Action {
    Action {
        at: 1_000 + i,
        usd_cents: i * 100,
        principal: PrincipalId(0),
        device: DeviceId(0),
        resource: ResourceId((i % 3) as u32),
        destination: i.is_multiple_of(2).then_some(DestinationId(7)),
        grant: None,
        kind: Kind::Transfer,
    }
}

fn write(path: &Path, key: &SigningKey, n: u64) {
    let mut l = Ledger::open(path, key.clone()).unwrap();
    l.name(Namespace::Principal, 0, "svc-withdrawal").unwrap();
    for i in 0..n {
        l.record(&action(i), if i % 5 == 0 { Decision::Deny(Reason::Frozen) } else { Decision::Allow }).unwrap();
        if i % 10 == 9 {
            l.checkpoint().unwrap();
        }
    }
    l.sync().unwrap();
}

#[test]
fn round_trips_and_verifies() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    write(&path, &key, 25);

    let mut seen = Vec::new();
    let mut names = Vec::new();
    let rep = read(&path, &key.verifying_key(), |item| match item {
        Item::Decision(e) => seen.push(e),
        Item::Name { name, .. } => names.push(name.to_owned()),
    })
    .unwrap();
    assert!(rep.intact(), "{:?}", rep.problem);
    assert_eq!(rep.decisions, 25);
    assert_eq!(rep.checkpoints, 2);
    assert_eq!(rep.signed_through, 20);
    assert_eq!(names, ["svc-withdrawal"]);
    assert_eq!(seen[3].action, action(3));
    assert_eq!(seen[5].decision_code, Decision::Deny(Reason::Frozen).code());
}

#[test]
fn reopening_continues_the_chain() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    write(&path, &key, 10);
    write(&path, &key, 10); // same name again: not rewritten
    let rep = verify(&path, &key.verifying_key()).unwrap();
    assert!(rep.intact(), "{:?}", rep.problem);
    assert_eq!(rep.decisions, 20);
}

#[test]
fn any_edit_is_detected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    write(&path, &key, 30);
    let clean = std::fs::read(&path).unwrap();

    // Flip one byte anywhere: verification must stop at or before that frame.
    for at in (0..clean.len()).step_by(37) {
        let mut bytes = clean.clone();
        bytes[at] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        let rep = verify(&path, &key.verifying_key()).unwrap();
        assert!(!rep.intact(), "flipping byte {at} went unnoticed");
    }

    // Truncation is reported too.
    std::fs::write(&path, &clean[..clean.len() - 5]).unwrap();
    assert!(!verify(&path, &key.verifying_key()).unwrap().intact());

    // And a broken ledger refuses new appends.
    assert!(Ledger::open(&path, key.clone()).is_err());
}

#[test]
fn a_rebuilt_chain_fails_the_signature() {
    // An attacker who rewrites history and recomputes every hash still can't sign checkpoints.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let real = generate_key();
    let forger = generate_key();
    write(&path, &forger, 20);
    let rep = verify(&path, &real.verifying_key()).unwrap();
    assert!(!rep.intact());
    assert!(rep.problem.unwrap().contains("signature"));
}
