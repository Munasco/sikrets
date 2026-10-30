//! sikrets-gateway: the only path to consequential actions.
//!
//! A signer, payment service or deploy system asks the gateway before acting. The gateway
//! decides with the deterministic policy engine and records the decision in the signed ledger.
//!
//! Durability: an `allow` is returned only after its ledger entry is on disk (group commit: one
//! fsync covers every decision since the last). Denials return immediately; nothing happens on a
//! denial, so there is nothing to lose.
//!
//! Environment:
//!   SIKRETS_POLICY       policy JSON (required)
//!   SIKRETS_DATA         directory for ledger.bin, ledger.key, ledger.pub (default ./data)
//!   SIKRETS_ADDR         listen address (default 127.0.0.1:7878)
//!   SIKRETS_ADMIN_TOKEN  bearer token for grants and device posture (admin routes off when unset)

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sikrets_audit::{Ledger, Namespace, SigningKey};
use sikrets_core::*;
use sikrets_policy::Engine;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

struct Core {
    engine: Engine,
    ledger: Ledger,
}

struct App {
    core: Mutex<Core>,
    /// Highest ledger length known to be on disk.
    durable: watch::Receiver<u64>,
    admin: Option<String>,
    public_key: String,
}

type Shared = Arc<App>;

fn now() -> Millis {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as Millis)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecideRequest {
    principal: String,
    device: String,
    resource: String,
    kind: Kind,
    #[serde(default)]
    destination: Option<String>,
    #[serde(default)]
    usd_cents: u64,
    #[serde(default)]
    grant: Option<u32>,
}

#[derive(Serialize)]
struct DecideResponse {
    /// "allow", "deny" or "hold" (waiting for a human).
    decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'static str>,
    seq: u64,
}

type ApiError = (StatusCode, String);

fn internal(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

async fn decide(State(app): State<Shared>, Json(req): Json<DecideRequest>) -> Result<Json<DecideResponse>, ApiError> {
    let (decision, seq) = {
        let mut c = app.core.lock().map_err(internal)?;
        let Core { engine, ledger } = &mut *c;
        let Some(resource) = engine.resource(&req.resource) else {
            return Err((StatusCode::NOT_FOUND, format!("no policy for resource \"{}\"", req.resource)));
        };
        let principal = engine.principal(&req.principal);
        let device = engine.device(&req.device);
        let destination = req.destination.as_deref().map(|d| engine.destination(d));
        ledger.name(Namespace::Principal, principal.0, &req.principal).map_err(internal)?;
        ledger.name(Namespace::Device, device.0, &req.device).map_err(internal)?;
        ledger.name(Namespace::Resource, resource.0, &req.resource).map_err(internal)?;
        if let (Some(d), Some(name)) = (destination, &req.destination) {
            ledger.name(Namespace::Destination, d.0, name).map_err(internal)?;
        }
        let action = Action {
            at: now(),
            usd_cents: req.usd_cents,
            principal,
            device,
            resource,
            destination,
            grant: req.grant.map(GrantId),
            kind: req.kind,
        };
        let d = engine.evaluate(&action);
        (d, ledger.record(&action, d).map_err(internal)?)
    };
    if decision.allowed() {
        // Don't let anyone act on an allow that isn't on disk yet.
        let mut durable = app.durable.clone();
        durable.wait_for(|&n| n > seq).await.map_err(internal)?;
    }
    Ok(Json(DecideResponse {
        decision: match decision {
            Decision::Allow => "allow",
            Decision::Deny(_) => "deny",
            Decision::Escalate(_) => "hold",
        },
        reason: decision.reason(),
        detail: decision.reason().map(Reason::describe),
        seq,
    }))
}

fn admin(app: &App, headers: &HeaderMap) -> Result<(), ApiError> {
    let Some(token) = &app.admin else {
        return Err((StatusCode::FORBIDDEN, "admin routes are off (set SIKRETS_ADMIN_TOKEN)".into()));
    };
    let given = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    // Constant-time comparison: don't leak the token through timing.
    let (a, b) = (given.as_bytes(), token.as_bytes());
    let same = a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0;
    if same { Ok(()) } else { Err((StatusCode::UNAUTHORIZED, "bad admin token".into())) }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRequest {
    principal: String,
    resource: String,
    kinds: Vec<Kind>,
    /// e.g. "45m"
    #[serde(rename = "for")]
    duration: String,
}

async fn grant(State(app): State<Shared>, headers: HeaderMap, Json(req): Json<GrantRequest>) -> Result<Json<serde_json::Value>, ApiError> {
    admin(&app, &headers)?;
    let ms = parse_duration(&req.duration).ok_or((StatusCode::BAD_REQUEST, "for: use a duration like 45m".into()))?;
    let mut c = app.core.lock().map_err(internal)?;
    let resource = c.engine.resource(&req.resource).ok_or((StatusCode::NOT_FOUND, "unknown resource".into()))?;
    let principal = c.engine.principal(&req.principal);
    let expires = now() + ms;
    let id = c.engine.grant(principal, resource, Kinds::of(&req.kinds), expires);
    Ok(Json(serde_json::json!({ "grant": id.0, "expires_at_ms": expires })))
}

async fn revoke(State(app): State<Shared>, headers: HeaderMap, Path(id): Path<u32>) -> Result<StatusCode, ApiError> {
    admin(&app, &headers)?;
    let revoked = app.core.lock().map_err(internal)?.engine.revoke(GrantId(id));
    Ok(if revoked { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND })
}

#[derive(Deserialize)]
struct PostureRequest {
    posture: Posture,
}

async fn posture(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(req): Json<PostureRequest>,
) -> Result<StatusCode, ApiError> {
    admin(&app, &headers)?;
    let mut c = app.core.lock().map_err(internal)?;
    let d = c.engine.device(&name);
    c.engine.set_posture(d, req.posture);
    Ok(StatusCode::NO_CONTENT)
}

async fn ledger_info(State(app): State<Shared>) -> Result<Json<serde_json::Value>, ApiError> {
    let c = app.core.lock().map_err(internal)?;
    let head: String = c.ledger.head().iter().map(|b| format!("{b:02x}")).collect();
    Ok(Json(serde_json::json!({ "decisions": c.ledger.len(), "head": head, "public_key": app.public_key })))
}

/// Group commit: hand frames to the OS under the lock (a memcpy), fsync outside it, then release
/// every allow waiting on those entries. Checkpoint once a second when there's anything new.
fn committer(app: Shared, durable: watch::Sender<u64>) {
    let mut last_checkpoint = std::time::Instant::now();
    let mut checkpointed = 0;
    loop {
        let (len, file) = {
            let mut c = app.core.lock().expect("ledger lock");
            let len = c.ledger.len();
            if len == *durable.borrow() {
                drop(c);
                std::thread::sleep(Duration::from_micros(200));
                continue;
            }
            if last_checkpoint.elapsed() >= Duration::from_secs(1) && len > checkpointed {
                c.ledger.checkpoint().expect("checkpoint");
                checkpointed = len;
                last_checkpoint = std::time::Instant::now();
            }
            c.ledger.flush().expect("ledger write");
            (len, c.ledger.file().expect("ledger handle"))
        };
        file.sync_data().expect("ledger fsync");
        durable.send_replace(len);
    }
}

/// The ledger signing key: 32 raw bytes, owner-only, created on first start.
fn load_key(dir: &std::path::Path) -> std::io::Result<SigningKey> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = dir.join("ledger.key");
    if let Ok(bytes) = std::fs::read(&path) {
        let seed: [u8; 32] = bytes.try_into().map_err(|_| std::io::Error::other("ledger.key must be 32 bytes"))?;
        return Ok(SigningKey::from_bytes(&seed));
    }
    let key = sikrets_audit::generate_key();
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
    std::io::Write::write_all(&mut f, &key.to_bytes())?;
    Ok(key)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let policy_path = std::env::var("SIKRETS_POLICY").map_err(|_| "set SIKRETS_POLICY to a policy JSON file")?;
    let data = std::path::PathBuf::from(std::env::var("SIKRETS_DATA").unwrap_or_else(|_| "data".into()));
    let addr = std::env::var("SIKRETS_ADDR").unwrap_or_else(|_| "127.0.0.1:7878".into());
    std::fs::create_dir_all(&data)?;

    let engine = Engine::from_json(&std::fs::read_to_string(&policy_path)?)?;
    let key = load_key(&data)?;
    let public_key: String = key.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(data.join("ledger.pub"), &public_key)?;
    let ledger = Ledger::open(&data.join("ledger.bin"), key)?;
    let (tx, rx) = watch::channel(ledger.len());

    let app = Arc::new(App {
        core: Mutex::new(Core { engine, ledger }),
        durable: rx,
        admin: std::env::var("SIKRETS_ADMIN_TOKEN").ok().filter(|t| t.len() >= 16),
        public_key,
    });
    std::thread::Builder::new().name("ledger-commit".into()).spawn({
        let app = app.clone();
        move || committer(app, tx)
    })?;

    let router = Router::new()
        .route("/v1/decide", post(decide))
        .route("/v1/grants", post(grant))
        .route("/v1/grants/{id}", delete(revoke))
        .route("/v1/devices/{name}/posture", put(posture))
        .route("/v1/ledger", get(ledger_info))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("sikrets-gateway on http://{addr} (policy {policy_path}, ledger {})", data.join("ledger.bin").display());
    axum::serve(listener, router).with_graceful_shutdown(shutdown()).await?;

    // Sign everything written so far, so the ledger ends on a checkpoint.
    let mut c = app.core.lock().map_err(|e| e.to_string())?;
    c.ledger.checkpoint()?;
    c.ledger.sync()?;
    eprintln!("sikrets-gateway stopped; ledger signed through decision {}", c.ledger.len());
    Ok(())
}

async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
