//! sikrets-gateway: the only path to consequential actions.
//!
//! A signer, payment service or deploy system asks the gateway before acting. The gateway
//! decides with the deterministic policy engine and records the decision in the signed ledger.
//!
//! Durability: an `allow` is returned only after its ledger entry is on disk (group commit: one
//! fsync covers every frame since the last). Denials return immediately; nothing happens on a
//! denial, so there is nothing to lose. Admin changes (grants, revocations, posture, unfreezes,
//! hold approvals) are written to the ledger first and answered once durable.
//!
//! State: the ledger is the only durable state. On start the gateway replays it to rebuild
//! grants, posture, ceiling windows, freezes and pending holds (see `restore`).
//!
//! Environment:
//!   SIKRETS_POLICY       policy JSON (required)
//!   SIKRETS_DATA         directory for ledger.bin, ledger.key, ledger.pub (default ./data)
//!   SIKRETS_ADDR         listen address (default 127.0.0.1:7878)
//!   SIKRETS_ADMIN_TOKEN  bearer token for grants, device posture, holds and unfreezes (admin
//!                        routes off when unset)

mod holds;
mod restore;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use holds::{HoldError, Holds};
use serde::{Deserialize, Serialize};
use sikrets_audit::{Event, Ledger, Namespace, SigningKey};
use sikrets_core::*;
use sikrets_policy::Engine;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

const LEDGER_FILE: &str = "ledger.bin";
const KEY_FILE: &str = "ledger.key";
const PUBLIC_KEY_FILE: &str = "ledger.pub";

struct Core {
    engine: Engine,
    ledger: Ledger,
    holds: Holds,
}

struct App {
    core: Mutex<Core>,
    /// Ledger frames known to be on disk.
    durable: watch::Receiver<u64>,
    admin: Option<String>,
    public_key: String,
    /// Why the ledger committer stopped. Once set, the gateway is unhealthy and can't allow.
    fatal: OnceLock<String>,
    /// Tells the committer to stop (shutdown).
    stopping: AtomicBool,
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

#[derive(Serialize, Debug)]
struct DecideResponse {
    /// "allow", "deny" or "hold" (waiting for a human; approve with `POST /v1/holds/{seq}/approve`).
    decision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Reason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'static str>,
    seq: u64,
}

impl DecideResponse {
    fn new(decision: Decision, seq: u64) -> Self {
        DecideResponse {
            decision: match decision {
                Decision::Allow => "allow",
                Decision::Deny(_) => "deny",
                Decision::Escalate(_) => "hold",
            },
            reason: decision.reason(),
            detail: decision.reason().map(Reason::describe),
            seq,
        }
    }
}

type ApiError = (StatusCode, String);

fn internal(e: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

impl App {
    /// The core, unless the gateway has failed. A poisoned lock means a panic mid-update, so the
    /// state behind it can't be trusted either.
    fn core(&self) -> Result<std::sync::MutexGuard<'_, Core>, ApiError> {
        if let Some(why) = self.fatal.get() {
            return Err((StatusCode::SERVICE_UNAVAILABLE, format!("gateway failed: {why}")));
        }
        self.core.lock().map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "gateway failed: state lock poisoned".into()))
    }

    /// Waits until the ledger holds `frames` frames on disk.
    async fn durable(&self, frames: u64) -> Result<(), ApiError> {
        let mut durable = self.durable.clone();
        durable.wait_for(|&n| n >= frames).await.map(drop).map_err(|_| {
            (StatusCode::SERVICE_UNAVAILABLE, format!("ledger commit stopped: {}", self.fatal.get().map_or("shutting down", |s| s)))
        })
    }

    fn health(&self) -> Result<(), String> {
        if let Some(why) = self.fatal.get() {
            return Err(why.clone());
        }
        let c = self.core.lock().map_err(|_| "state lock poisoned".to_owned())?;
        match c.ledger.failure() {
            Some(why) => Err(format!("ledger: {why}")),
            None => Ok(()),
        }
    }
}

async fn decide(State(app): State<Shared>, Json(req): Json<DecideRequest>) -> Result<Json<DecideResponse>, ApiError> {
    let (decision, seq, frames) = {
        let mut c = app.core()?;
        let Core { engine, ledger, holds } = &mut *c;
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
        let seq = ledger.record(&action, d).map_err(internal)?;
        if let Decision::Escalate(_) = d {
            holds.open(seq, action);
        }
        (d, seq, ledger.frames())
    };
    if decision.allowed() || matches!(decision, Decision::Escalate(_)) {
        // Don't let anyone act on an allow, or ask to approve a hold, that isn't on disk yet.
        app.durable(frames).await?;
    }
    Ok(Json(DecideResponse::new(decision, seq)))
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
    let (id, expires, frames) = {
        let mut c = app.core()?;
        let Core { engine, ledger, .. } = &mut *c;
        let resource = engine.resource(&req.resource).ok_or((StatusCode::NOT_FOUND, "unknown resource".into()))?;
        let principal = engine.principal(&req.principal);
        ledger.name(Namespace::Principal, principal.0, &req.principal).map_err(internal)?;
        ledger.name(Namespace::Resource, resource.0, &req.resource).map_err(internal)?;
        let at = now();
        let (id, kinds, not_after) = (engine.next_grant(), Kinds::of(&req.kinds), at + ms);
        ledger.event(&Event::Grant { at, id, principal, resource, kinds, not_after }).map_err(internal)?;
        let issued = engine.grant(principal, resource, kinds, not_after);
        debug_assert_eq!(issued, id);
        (id, not_after, ledger.frames())
    };
    app.durable(frames).await?;
    Ok(Json(serde_json::json!({ "grant": id.0, "expires_at_ms": expires })))
}

async fn revoke(State(app): State<Shared>, headers: HeaderMap, Path(id): Path<u32>) -> Result<StatusCode, ApiError> {
    admin(&app, &headers)?;
    let frames = {
        let mut c = app.core()?;
        let grant = GrantId(id);
        if c.engine.grant_info(grant).is_none_or(|g| g.revoked) {
            return Ok(StatusCode::NOT_FOUND);
        }
        c.ledger.event(&Event::Revoke { at: now(), grant }).map_err(internal)?;
        c.engine.revoke(grant);
        c.ledger.frames()
    };
    app.durable(frames).await?;
    Ok(StatusCode::NO_CONTENT)
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
    let frames = {
        let mut c = app.core()?;
        let Core { engine, ledger, .. } = &mut *c;
        let device = engine.device(&name);
        ledger.name(Namespace::Device, device.0, &name).map_err(internal)?;
        ledger.event(&Event::Posture { at: now(), device, posture: req.posture }).map_err(internal)?;
        engine.set_posture(device, req.posture);
        ledger.frames()
    };
    app.durable(frames).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Lifts a ceiling freeze early, after a human decided the burst was legitimate.
async fn unfreeze(State(app): State<Shared>, headers: HeaderMap, Path(name): Path<String>) -> Result<StatusCode, ApiError> {
    admin(&app, &headers)?;
    let frames = {
        let mut c = app.core()?;
        let Core { engine, ledger, .. } = &mut *c;
        let resource = engine.resource(&name).ok_or((StatusCode::NOT_FOUND, "unknown resource".into()))?;
        let at = now();
        if engine.frozen_until(resource, at).is_none() {
            return Ok(StatusCode::CONFLICT);
        }
        ledger.name(Namespace::Resource, resource.0, &name).map_err(internal)?;
        ledger.event(&Event::Unfreeze { at, resource }).map_err(internal)?;
        engine.unfreeze(resource);
        ledger.frames()
    };
    app.durable(frames).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn hold_error(e: HoldError) -> ApiError {
    match e {
        HoldError::Unknown => (StatusCode::NOT_FOUND, "no hold with that seq".into()),
        HoldError::Expired => (StatusCode::GONE, "the hold expired; ask again".into()),
        HoldError::Settled => (StatusCode::CONFLICT, "the hold was already approved or denied".into()),
    }
}

/// Approves a held action: every check runs again now, except the approval threshold. The
/// approval and the new decision both go in the ledger.
async fn approve(State(app): State<Shared>, headers: HeaderMap, Path(seq): Path<u64>) -> Result<Json<DecideResponse>, ApiError> {
    admin(&app, &headers)?;
    let (decision, seq, frames) = {
        let mut c = app.core()?;
        let Core { engine, ledger, holds } = &mut *c;
        let at = now();
        let held = holds.pending(seq, at).map_err(hold_error)?;
        ledger.event(&Event::Resolve { at, seq, approved: true }).map_err(internal)?;
        holds.settle(seq, true).map_err(hold_error)?;
        let action = Action { at, ..held };
        let d = engine.evaluate_approved(&action);
        (d, ledger.record(&action, d).map_err(internal)?, ledger.frames())
    };
    app.durable(frames).await?;
    Ok(Json(DecideResponse::new(decision, seq)))
}

async fn deny(State(app): State<Shared>, headers: HeaderMap, Path(seq): Path<u64>) -> Result<StatusCode, ApiError> {
    admin(&app, &headers)?;
    let frames = {
        let mut c = app.core()?;
        let Core { ledger, holds, .. } = &mut *c;
        let at = now();
        holds.pending(seq, at).map_err(hold_error)?;
        ledger.event(&Event::Resolve { at, seq, approved: false }).map_err(internal)?;
        holds.settle(seq, false).map_err(hold_error)?;
        ledger.frames()
    };
    app.durable(frames).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ledger_info(State(app): State<Shared>) -> Result<Json<serde_json::Value>, ApiError> {
    let c = app.core()?;
    let head: String = c.ledger.head().iter().map(|b| format!("{b:02x}")).collect();
    Ok(Json(serde_json::json!({ "decisions": c.ledger.len(), "head": head, "public_key": app.public_key })))
}

async fn healthz(State(app): State<Shared>) -> (StatusCode, String) {
    match app.health() {
        Ok(()) => (StatusCode::OK, "ok".into()),
        Err(why) => (StatusCode::SERVICE_UNAVAILABLE, why),
    }
}

/// Group commit: hand frames to the OS under the lock (a memcpy), fsync outside it, then release
/// every request waiting on those frames. Checkpoint once a second when there's anything new.
///
/// Any failure is fatal: the gateway turns unhealthy and stops allowing, and nothing waiting is
/// released. A supervisor restarts it; the ledger cuts off a torn final frame on open.
fn committer(app: Shared, durable: watch::Sender<u64>) {
    if let Err(why) = commit_loop(&app, &durable) {
        eprintln!("sikrets-gateway: ledger commit failed, refusing further allows: {why}");
        let _ = app.fatal.set(why);
    }
}

fn commit_loop(app: &App, durable: &watch::Sender<u64>) -> Result<(), String> {
    let mut last_checkpoint = std::time::Instant::now();
    let mut checkpointed = 0;
    while !app.stopping.load(Ordering::Acquire) {
        let (frames, file) = {
            let mut c = app.core.lock().map_err(|_| "state lock poisoned".to_owned())?;
            if c.ledger.frames() == *durable.borrow() {
                drop(c);
                std::thread::sleep(Duration::from_micros(200));
                continue;
            }
            let decisions = c.ledger.len();
            if last_checkpoint.elapsed() >= Duration::from_secs(1) && decisions > checkpointed {
                c.ledger.checkpoint().map_err(|e| format!("checkpoint: {e}"))?;
                checkpointed = decisions;
                last_checkpoint = std::time::Instant::now();
            }
            c.ledger.flush().map_err(|e| format!("ledger write: {e}"))?;
            (c.ledger.frames(), c.ledger.file().map_err(|e| format!("ledger handle: {e}"))?)
        };
        file.sync_data().map_err(|e| format!("ledger fsync: {e}"))?;
        durable.send_replace(frames);
    }
    Ok(())
}

/// The ledger signing key: 32 raw bytes, owner-only, created on first start.
///
/// A ledger without its key can't be extended (checkpoints would fail to verify), so a missing
/// key next to an existing ledger is an error, never a reason to make a new one. A new key is
/// written to a temp file and linked into place, so a crash can't leave a short key and two
/// starts can't both create one.
fn load_key(dir: &std::path::Path) -> std::io::Result<SigningKey> {
    use std::io::ErrorKind;
    use std::os::unix::fs::OpenOptionsExt;
    let path = dir.join(KEY_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let seed: [u8; 32] = bytes.try_into().map_err(|_| std::io::Error::other(format!("{KEY_FILE} must be 32 bytes")))?;
            return Ok(SigningKey::from_bytes(&seed));
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    if dir.join(LEDGER_FILE).exists() {
        return Err(std::io::Error::other(format!(
            "{KEY_FILE} is missing but {LEDGER_FILE} exists in {}; restore the key (a new one can't extend this ledger)",
            dir.display()
        )));
    }
    let key = sikrets_audit::generate_key();
    let tmp = dir.join(format!("{KEY_FILE}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let written = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        std::io::Write::write_all(&mut f, &key.to_bytes())?;
        f.sync_all()?;
        std::fs::hard_link(&tmp, &path)
    })();
    let _ = std::fs::remove_file(&tmp);
    match written {
        Ok(()) => Ok(key),
        // Another start won the race: use its key.
        Err(e) if e.kind() == ErrorKind::AlreadyExists => load_key(dir),
        Err(e) => Err(e),
    }
}

/// Opens the ledger and rebuilds the engine and holds from it.
fn open(
    policy_json: &str,
    data: &std::path::Path,
    admin: Option<String>,
) -> Result<(Shared, watch::Sender<u64>), Box<dyn std::error::Error>> {
    let mut engine = Engine::from_json(policy_json)?;
    let key = load_key(data)?;
    let public_key: String = key.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(data.join(PUBLIC_KEY_FILE), &public_key)?;
    let mut holds = Holds::default();
    let ledger = {
        let mut restore = restore::Restore::new(&mut engine, &mut holds);
        Ledger::open_with(&data.join(LEDGER_FILE), key, |item| restore.apply(item))?
    };
    if ledger.recovered() > 0 {
        eprintln!("sikrets-gateway: cut a torn final frame ({} bytes) off the ledger; it was never synced", ledger.recovered());
    }
    let (tx, rx) = watch::channel(ledger.frames());
    let app = Arc::new(App {
        core: Mutex::new(Core { engine, ledger, holds }),
        durable: rx,
        admin,
        public_key,
        fatal: OnceLock::new(),
        stopping: AtomicBool::new(false),
    });
    Ok((app, tx))
}

fn router(app: Shared) -> Router {
    Router::new()
        .route("/v1/decide", post(decide))
        .route("/v1/grants", post(grant))
        .route("/v1/grants/{id}", delete(revoke))
        .route("/v1/devices/{name}/posture", put(posture))
        .route("/v1/resources/{name}/unfreeze", post(unfreeze))
        .route("/v1/holds/{seq}/approve", post(approve))
        .route("/v1/holds/{seq}/deny", post(deny))
        .route("/v1/ledger", get(ledger_info))
        .route("/healthz", get(healthz))
        .with_state(app)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let policy_path = std::env::var("SIKRETS_POLICY").map_err(|_| "set SIKRETS_POLICY to a policy JSON file")?;
    let data = std::path::PathBuf::from(std::env::var("SIKRETS_DATA").unwrap_or_else(|_| "data".into()));
    let addr = std::env::var("SIKRETS_ADDR").unwrap_or_else(|_| "127.0.0.1:7878".into());
    std::fs::create_dir_all(&data)?;

    let admin = std::env::var("SIKRETS_ADMIN_TOKEN").ok().filter(|t| t.len() >= 16);
    let (app, tx) = open(&std::fs::read_to_string(&policy_path)?, &data, admin)?;
    let commit = std::thread::Builder::new().name("ledger-commit".into()).spawn({
        let app = app.clone();
        move || committer(app, tx)
    })?;

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("sikrets-gateway on http://{addr} (policy {policy_path}, ledger {})", data.join(LEDGER_FILE).display());
    axum::serve(listener, router(app.clone())).with_graceful_shutdown(shutdown()).await?;

    // Sign everything written so far, so the ledger ends on a checkpoint.
    app.stopping.store(true, Ordering::Release);
    let _ = commit.join();
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

#[cfg(test)]
mod tests;
