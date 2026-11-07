//! Restart, crash and concurrency behavior of the gateway, driven through the route handlers.

use super::*;
use sikrets_audit::{Item, VerifyingKey};
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;

const POLICY: &str = r#"{
  "resources": {
    "eth-hot-wallet": {
      "allow": ["transfer"],
      "destinations": ["cold-eth"],
      "approval_over": "$5m",
      "ceilings": [{ "window": "10m", "max": "$20m" }],
      "freeze_for": "1h"
    },
    "vault": { "allow": ["read"], "requires_grant": true }
  }
}"#;
const TOKEN: &str = "test-admin-token-0123456789";

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("sikrets-gateway-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A running gateway: app plus its commit thread.
struct Gateway {
    app: Shared,
    commit: Option<std::thread::JoinHandle<()>>,
}

impl Gateway {
    fn start(dir: &Dir) -> Self {
        let (app, tx) = open(POLICY, &dir.0, Some(TOKEN.into())).unwrap();
        let commit = std::thread::spawn({
            let app = app.clone();
            move || committer(app, tx)
        });
        Gateway { app, commit: Some(commit) }
    }

    /// Stops like a crash after the last durable write: no final checkpoint.
    fn stop(mut self) {
        self.app.stopping.store(true, Ordering::Release);
        self.commit.take().unwrap().join().unwrap();
    }

    fn state(&self) -> State<Shared> {
        State(self.app.clone())
    }

    async fn decide(&self, principal: &str, resource: &str, kind: &str, dollars: u64, grant: Option<u32>) -> DecideResponse {
        let req = serde_json::from_value(serde_json::json!({
            "principal": principal, "device": "ops-laptop", "resource": resource, "kind": kind,
            "destination": "cold-eth", "usd_cents": dollars * 100, "grant": grant,
        }))
        .unwrap();
        decide(self.state(), Json(req)).await.unwrap().0
    }

    async fn grant(&self, principal: &str, resource: &str) -> u32 {
        let req =
            serde_json::from_value(serde_json::json!({ "principal": principal, "resource": resource, "kinds": ["read"], "for": "1h" }))
                .unwrap();
        grant(self.state(), auth(), Json(req)).await.unwrap().0["grant"].as_u64().unwrap() as u32
    }

    async fn healthy_device(&self) {
        let req = PostureRequest { posture: Posture::Healthy };
        assert_eq!(posture(self.state(), auth(), Path("ops-laptop".into()), Json(req)).await.unwrap(), StatusCode::NO_CONTENT);
    }
}

fn auth() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    h
}

fn key(dir: &Dir) -> VerifyingKey {
    load_key(&dir.0).unwrap().verifying_key()
}

#[tokio::test]
async fn names_stay_right_across_a_restart() {
    let dir = Dir::new();
    let gw = Gateway::start(&dir);
    gw.decide("alice", "vault", "read", 0, None).await;
    gw.stop();
    // The new run sees mallory first. Before the fix she got id 0 and inherited alice's name.
    let gw = Gateway::start(&dir);
    gw.decide("mallory", "vault", "read", 0, None).await;
    gw.decide("alice", "vault", "read", 0, None).await;
    gw.stop();

    let mut names: Vec<Option<String>> = Vec::new();
    let mut who = Vec::new();
    sikrets_audit::read(&dir.0.join(LEDGER_FILE), &key(&dir), |item| match item {
        Item::Name { namespace: 0, id, name } => {
            names.resize(names.len().max(id as usize + 1), None);
            names[id as usize] = Some(name.to_owned());
        }
        Item::Decision(e) => who.push(names[e.action.principal.index()].clone().unwrap()),
        _ => {}
    })
    .unwrap();
    assert_eq!(who, ["alice", "mallory", "alice"]);
}

#[tokio::test]
async fn a_restart_keeps_freezes_grants_and_posture() {
    let dir = Dir::new();
    let gw = Gateway::start(&dir);
    gw.healthy_device().await;
    let kept = gw.grant("svc", "vault").await;
    let revoked = gw.grant("svc", "vault").await;
    assert_eq!(revoke(gw.state(), auth(), Path(revoked)).await.unwrap(), StatusCode::NO_CONTENT);
    for _ in 0..5 {
        gw.decide("svc", "eth-hot-wallet", "transfer", 4_000_000, None).await;
    }
    let tripped = gw.decide("svc", "eth-hot-wallet", "transfer", 4_000_000, None).await;
    assert_eq!(tripped.reason, Some(Reason::CeilingExceeded));
    gw.stop();

    let gw = Gateway::start(&dir);
    let small = gw.decide("svc", "eth-hot-wallet", "transfer", 1, None).await;
    assert_eq!((small.decision, small.reason), ("deny", Some(Reason::Frozen)), "the freeze survives a restart");
    assert_eq!(gw.decide("svc", "vault", "read", 0, Some(kept)).await.decision, "allow", "grant and posture survive");
    assert_eq!(gw.decide("svc", "vault", "read", 0, Some(revoked)).await.reason, Some(Reason::GrantRevoked));
    let fresh = gw.grant("svc", "vault").await;
    assert!(fresh > revoked, "grant ids are never reused");

    // An early unfreeze is logged and survives a restart too; the window still counts the $20m.
    assert_eq!(unfreeze(gw.state(), auth(), Path("eth-hot-wallet".into())).await.unwrap(), StatusCode::NO_CONTENT);
    gw.stop();
    let gw = Gateway::start(&dir);
    let after = gw.decide("svc", "eth-hot-wallet", "transfer", 1, None).await;
    assert_eq!(after.reason, Some(Reason::CeilingExceeded), "unfrozen, but the rolling sum was rebuilt");
    gw.stop();
}

#[tokio::test]
async fn a_hold_can_be_approved_once_even_after_a_restart() {
    let dir = Dir::new();
    let gw = Gateway::start(&dir);
    gw.healthy_device().await;
    let held = gw.decide("svc", "eth-hot-wallet", "transfer", 6_000_000, None).await;
    assert_eq!(held.decision, "hold");
    let denied = gw.decide("svc", "eth-hot-wallet", "transfer", 7_000_000, None).await;
    assert_eq!(deny(gw.state(), auth(), Path(denied.seq)).await.unwrap(), StatusCode::NO_CONTENT);
    gw.stop();

    let gw = Gateway::start(&dir);
    let approved = approve(gw.state(), auth(), Path(held.seq)).await.unwrap().0;
    assert_eq!(approved.decision, "allow");
    assert!(approved.seq > held.seq);
    let again = approve(gw.state(), auth(), Path(held.seq)).await.unwrap_err();
    assert_eq!(again.0, StatusCode::CONFLICT);
    assert_eq!(approve(gw.state(), auth(), Path(denied.seq)).await.unwrap_err().0, StatusCode::CONFLICT, "denied before the restart");
    assert_eq!(approve(gw.state(), auth(), Path(9_999)).await.unwrap_err().0, StatusCode::NOT_FOUND);
    assert_eq!(approve(gw.state(), HeaderMap::new(), Path(held.seq)).await.unwrap_err().0, StatusCode::UNAUTHORIZED);
    gw.stop();
}

#[tokio::test]
async fn a_poisoned_lock_makes_the_gateway_unhealthy() {
    let dir = Dir::new();
    let gw = Gateway::start(&dir);
    assert_eq!(healthz(gw.state()).await.0, StatusCode::OK);
    let app = gw.app.clone();
    let _ = std::thread::spawn(move || {
        let _guard = app.core.lock().unwrap();
        panic!("simulated panic while holding the lock");
    })
    .join();
    assert_eq!(healthz(gw.state()).await.0, StatusCode::SERVICE_UNAVAILABLE);
    let req = serde_json::from_value(serde_json::json!({ "principal": "a", "device": "d", "resource": "vault", "kind": "read" })).unwrap();
    assert_eq!(decide(gw.state(), Json(req)).await.unwrap_err().0, StatusCode::SERVICE_UNAVAILABLE);
    // The committer notices too and records why.
    let mut gw = gw;
    gw.commit.take().unwrap().join().unwrap();
    assert!(gw.app.fatal.get().is_some_and(|w| w.contains("poisoned")));
}

#[test]
fn a_missing_key_next_to_a_ledger_is_an_error() {
    let dir = Dir::new();
    let first = load_key(&dir.0).unwrap();
    assert_eq!(load_key(&dir.0).unwrap().to_bytes(), first.to_bytes(), "the key is read back, not replaced");
    std::fs::write(dir.0.join(LEDGER_FILE), b"").unwrap();
    std::fs::remove_file(dir.0.join(KEY_FILE)).unwrap();
    let err = load_key(&dir.0).unwrap_err();
    assert!(err.to_string().contains("missing"), "{err}");
    assert!(!dir.0.join(KEY_FILE).exists());
}
