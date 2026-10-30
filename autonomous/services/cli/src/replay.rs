//! Replays an attack timeline through the policy gateway, once per defence layer, and records
//! every decision in a signed ledger.
//!
//! Layers, each assuming more went wrong for the defender:
//! 1. As it was: the signer signs whatever the service asks.
//! 2. Sikrets: standing access replaced by grants (the scan's fix).
//! 3. …and the attacker hijacks a live 45-minute grant from a healthy-looking device.
//! 4. …and the grant is renewed all night, the attacker controls an allowlisted address, and
//!    splits every transfer to stay under the approval threshold.

use crate::hex;
use serde::Deserialize;
use sikrets_audit::{Ledger, Namespace, generate_key};
use sikrets_core::*;
use sikrets_policy::Engine;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::Instant;

#[derive(Deserialize)]
struct Timeline {
    title: String,
    source: String,
    attacker: Attacker,
    events: Vec<Event>,
}

#[derive(Deserialize)]
struct Attacker {
    principal: String,
    device: String,
}

#[derive(Deserialize, Clone)]
struct Event {
    at: jiff::Timestamp,
    resource: String,
    kind: Kind,
    to: String,
    usd: String,
    #[serde(default)]
    repeat: Option<u32>,
    /// Executed by code the wallet delegated to; impossible if no delegation was ever allowed.
    #[serde(default)]
    via_delegation: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Layer {
    AsItWas,
    Sikrets,
    StolenGrant,
    Worst,
}

impl Layer {
    fn title(self) -> &'static str {
        match self {
            Layer::AsItWas => "As it was: the signer signs whatever the service asks",
            Layer::Sikrets => "Sikrets: standing access replaced by grants",
            Layer::StolenGrant => "…attacker hijacks a live 45-minute grant, device looks healthy",
            Layer::Worst => "…grant renewed all night, attacker owns an allowlisted address, splits under $5m",
        }
    }
    fn slug(self) -> &'static str {
        match self {
            Layer::AsItWas => "as-it-was",
            Layer::Sikrets => "sikrets",
            Layer::StolenGrant => "stolen-grant",
            Layer::Worst => "worst-case",
        }
    }
}

#[derive(Default)]
struct Outcome {
    attempted: u64,
    lost: u64,
    decisions: u64,
    stopped: BTreeMap<String, u64>,
    impossible: u64,
    first_stop: Option<Millis>,
    eval_ns: u128,
}

pub fn run(dir: &Path, out: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).map_err(|e| format!("{}: {e}", dir.join(f).display()));
    let t: Timeline = serde_json::from_str(&read("timeline.json")?)?;
    let as_was = read("policy-as-was.json")?;
    let sikrets = read("policy.json")?;
    std::fs::create_dir_all(out)?;
    let key = generate_key();
    std::fs::write(out.join("ledger.pub"), hex(&key.verifying_key().to_bytes()))?;

    let attempted: u64 = t.events.iter().map(|e| usd(e) * e.repeat.unwrap_or(1) as u64).sum();
    let wallets: HashSet<&str> = t.events.iter().map(|e| e.resource.as_str()).collect();
    println!("{}", t.title);
    println!("{} attempted from {} hot wallets. {}\n", format_usd(attempted), wallets.len(), wrap(&t.source));

    let mut rows = Vec::new();
    for layer in [Layer::AsItWas, Layer::Sikrets, Layer::StolenGrant, Layer::Worst] {
        let policy = if layer == Layer::AsItWas { &as_was } else { &sikrets };
        let path = out.join(format!("ledger-{}.bin", layer.slug()));
        let _ = std::fs::remove_file(&path);
        let o = play(&t, policy, layer, &mut Ledger::open(&path, key.clone())?)?;
        rows.push((layer, o, path));
    }

    println!("{:<84} {:>9}", "", "LOST");
    for (layer, o, _) in &rows {
        println!("{:<84} {:>9}", layer.title(), format_usd(o.lost));
        let mut why: Vec<String> = o.stopped.iter().map(|(r, n)| format!("{r} ×{n}")).collect();
        if o.impossible > 0 {
            why.push(format!("sweeps impossible without the delegation ×{}", o.impossible));
        }
        if !why.is_empty() {
            println!("    stopped by: {}", why.join(", "));
        }
        if let Some(at) = o.first_stop {
            let t = jiff::Timestamp::from_millisecond(at as i64)?;
            println!("    first stop at {} UTC", t.strftime("%H:%M:%S"));
        }
    }

    println!("\nEvidence");
    for (layer, o, path) in &rows {
        let rep = sikrets_audit::verify(path, &key.verifying_key())?;
        let ok = if rep.intact() { "✓ intact" } else { "✗ broken" };
        println!(
            "  {:<13} {} decisions in {:>6.1} µs ({:>4.0} ns each)  {ok}, signed through {}  {}",
            layer.slug(),
            o.decisions,
            o.eval_ns as f64 / 1_000.0,
            o.eval_ns as f64 / o.decisions.max(1) as f64,
            rep.signed_through,
            path.display()
        );
    }
    println!("  verify: sikrets-auto ledger verify {}", rows[1].2.display());
    Ok(())
}

fn usd(e: &Event) -> u64 {
    parse_usd(&e.usd).unwrap_or(0)
}

fn wrap(s: &str) -> String {
    let mut out = String::new();
    let mut col = 0;
    for w in s.split_whitespace() {
        if col + w.len() > 100 {
            out.push('\n');
            col = 0;
        } else if col > 0 {
            out.push(' ');
            col += 1;
        }
        out.push_str(w);
        col += w.len();
    }
    format!("\n{out}")
}

const APPROVAL_SPLIT: u64 = 499_000_000; // $4.99m in cents
const MINUTE: Millis = 60_000;

fn play(t: &Timeline, policy: &str, layer: Layer, ledger: &mut Ledger) -> Result<Outcome, Box<dyn std::error::Error>> {
    let mut e = Engine::from_json(policy)?;
    let principal = e.principal(&t.attacker.principal);
    let device = e.device(&t.attacker.device);
    // Worst case for the defender: the endpoint sensor saw nothing.
    e.set_posture(device, Posture::Healthy);
    ledger.name(Namespace::Principal, principal.0, &t.attacker.principal)?;
    ledger.name(Namespace::Device, device.0, &t.attacker.device)?;

    let start = t.events.iter().map(|e| e.at.as_millisecond() as Millis).min().unwrap_or(0);
    let mut grants = BTreeMap::new();
    if matches!(layer, Layer::StolenGrant | Layer::Worst) {
        let until = if layer == Layer::Worst { Millis::MAX } else { start + 45 * MINUTE };
        for ev in &t.events {
            if let Some(r) = e.resource(&ev.resource) {
                grants.entry(r).or_insert_with(|| e.grant(principal, r, Kinds::of(&[Kind::Transfer, Kind::Sign]), until));
            }
        }
    }

    let mut o = Outcome::default();
    let mut delegated: HashSet<(ResourceId, DestinationId)> = HashSet::new();
    for ev in &t.events {
        let Some(resource) = e.resource(&ev.resource) else { continue };
        // The worst-case attacker routes through an address the allowlist trusts.
        let to_name = if layer == Layer::Worst { allowlisted(&ev.resource) } else { ev.to.clone() };
        let to = e.destination(&to_name);
        ledger.name(Namespace::Resource, resource.0, &ev.resource)?;
        ledger.name(Namespace::Destination, to.0, &to_name)?;
        let base = ev.at.as_millisecond() as Millis;
        let total = usd(ev);
        for i in 0..ev.repeat.unwrap_or(1) as u64 {
            o.attempted += total;
            if ev.via_delegation && !delegated.contains(&(resource, to)) {
                o.impossible += 1;
                o.first_stop.get_or_insert(base);
                continue;
            }
            // Adaptive attacker: chunks under the approval threshold, two seconds apart.
            let chunks: Vec<u64> = if layer == Layer::Worst && total > APPROVAL_SPLIT {
                let n = total.div_ceil(APPROVAL_SPLIT);
                (0..n).map(|c| if c + 1 < n { APPROVAL_SPLIT } else { total - APPROVAL_SPLIT * (n - 1) }).collect()
            } else {
                vec![total]
            };
            for (c, &cents) in chunks.iter().enumerate() {
                let a = Action {
                    at: base + i * 100 + c as u64 * 2_000,
                    usd_cents: cents,
                    principal,
                    device,
                    resource,
                    destination: Some(to),
                    grant: grants.get(&resource).copied(),
                    kind: ev.kind,
                };
                let t0 = Instant::now();
                let d = e.evaluate(&a);
                o.eval_ns += t0.elapsed().as_nanos();
                o.decisions += 1;
                ledger.record(&a, d)?;
                match d {
                    Decision::Allow => {
                        o.lost += cents;
                        if a.kind == Kind::Delegate {
                            delegated.insert((resource, to));
                        }
                    }
                    Decision::Deny(r) | Decision::Escalate(r) => {
                        *o.stopped.entry(r.describe().split([';', ',']).next().unwrap_or("").to_owned()).or_default() += 1;
                        o.first_stop.get_or_insert(a.at);
                    }
                }
            }
            if o.decisions % 256 == 0 {
                ledger.checkpoint()?;
            }
        }
    }
    ledger.checkpoint()?;
    ledger.sync()?;
    Ok(o)
}

fn allowlisted(resource: &str) -> String {
    let chain = resource.split('-').next().unwrap_or(resource);
    format!("{chain}-user-withdrawals")
}
