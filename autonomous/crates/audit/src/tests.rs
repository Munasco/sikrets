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
        Item::Event(_) => {}
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

    // A short tail reads as a torn final frame, which open cuts off; flipped bytes above refuse.
    let mut l = Ledger::open(&path, key.clone()).unwrap();
    assert!(l.recovered() > 0);
    assert_eq!(l_len(&path), clean.len() as u64 - 5 - l.recovered());
    l.sync().unwrap();
    assert!(verify(&path, &key.verifying_key()).unwrap().intact());
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

#[test]
fn a_rebound_id_gets_a_new_name_frame() {
    // A restart hands id 0 to someone new. The ledger must say so, not keep the old name.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    {
        let mut l = Ledger::open(&path, key.clone()).unwrap();
        l.name(Namespace::Principal, 0, "alice").unwrap();
        l.record(&action(0), Decision::Allow).unwrap();
        l.sync().unwrap();
    }
    let mut l = Ledger::open(&path, key.clone()).unwrap();
    assert_eq!(l.name_of(Namespace::Principal, 0), Some("alice"), "name table rebuilt on open");
    l.name(Namespace::Principal, 0, "alice").unwrap();
    let before = l.frames();
    l.name(Namespace::Principal, 0, "mallory").unwrap();
    assert_eq!(l.frames(), before + 1);
    l.record(&action(1), Decision::Allow).unwrap();
    l.sync().unwrap();

    // Walking the file in order attributes each decision to the name in force at the time.
    let mut current = String::new();
    let mut who = Vec::new();
    read(&path, &key.verifying_key(), |item| match item {
        Item::Name { name, .. } => current = name.to_owned(),
        Item::Decision(_) => who.push(current.clone()),
        Item::Event(_) => {}
    })
    .unwrap();
    assert_eq!(who, ["alice", "mallory"]);
}

#[test]
fn events_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    let events = [
        Event::Grant {
            at: 5,
            id: GrantId(3),
            principal: PrincipalId(1),
            resource: ResourceId(2),
            kinds: Kinds::of(&[Kind::Transfer, Kind::Sign]),
            not_after: 99,
        },
        Event::Revoke { at: 6, grant: GrantId(3) },
        Event::Posture { at: 7, device: DeviceId(4), posture: Posture::Compromised },
        Event::Unfreeze { at: 8, resource: ResourceId(2) },
        Event::Resolve { at: 9, seq: 41, approved: true },
    ];
    {
        let mut l = Ledger::open(&path, key.clone()).unwrap();
        for e in &events {
            l.event(e).unwrap();
        }
        l.sync().unwrap();
        assert_eq!(l.frames(), events.len() as u64);
    }
    let mut seen = Vec::new();
    let l = Ledger::open_with(&path, key.clone(), |item| {
        if let Item::Event(e) = item {
            seen.push(e);
        }
    })
    .unwrap();
    assert_eq!(seen, events);
    assert_eq!(l.frames(), events.len() as u64);
}

#[test]
fn a_torn_final_frame_is_cut_off_on_open() {
    // Crash in the middle of an append: the last frame is only partly on disk.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    write(&path, &key, 12);
    let clean = std::fs::read(&path).unwrap();
    let mut l = Ledger::open(&path, key.clone()).unwrap();
    l.record(&action(12), Decision::Allow).unwrap();
    l.sync().unwrap();
    drop(l);
    let full = std::fs::read(&path).unwrap();
    std::fs::write(&path, &full[..clean.len() + 20]).unwrap();

    let mut l = Ledger::open(&path, key.clone()).unwrap();
    assert_eq!(l.recovered(), 20);
    assert_eq!(l.len(), 12);
    assert_eq!(std::fs::metadata(&path).unwrap().len(), clean.len() as u64);
    l.record(&action(12), Decision::Allow).unwrap();
    l.checkpoint().unwrap();
    l.sync().unwrap();
    let rep = verify(&path, &key.verifying_key()).unwrap();
    assert!(rep.intact(), "{:?}", rep.problem);
    assert_eq!(rep.decisions, 13);
}

#[test]
fn damage_before_the_tail_is_not_repaired() {
    // Only a short tail is treated as a torn write; an altered frame still refuses to open.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.bin");
    let key = generate_key();
    write(&path, &key, 12);
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[60] ^= 1;
    std::fs::write(&path, &bytes).unwrap();
    assert!(Ledger::open(&path, key.clone()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes, "nothing was cut");
}

fn l_len(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().len()
}
