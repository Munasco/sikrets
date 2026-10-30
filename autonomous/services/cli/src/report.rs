//! Terminal output for people.

use sikrets_core::{Kind, Reason};
use sikrets_scan::{Finding, Guardrail, Report, Severity};
use sikrets_triage::Triage;
use std::collections::BTreeMap;

pub fn outcome(code: u8) -> String {
    if code == 0 {
        return "allowed".into();
    }
    let held = code & 0x80 != 0;
    let reason = REASONS.iter().find(|r| **r as u8 == code & 0x7f).map(|r| format!("{r:?}")).unwrap_or_else(|| format!("code {code}"));
    format!("{} {}", if held { "held" } else { "denied" }, snake(&reason))
}

const REASONS: [Reason; 11] = [
    Reason::UnknownResource,
    Reason::KindNotAllowed,
    Reason::NoGrant,
    Reason::GrantExpired,
    Reason::GrantMismatch,
    Reason::DevicePosture,
    Reason::DestinationNotAllowed,
    Reason::CeilingExceeded,
    Reason::Frozen,
    Reason::NeedsApproval,
    Reason::GrantRevoked,
];

fn snake(camel: &str) -> String {
    let mut s = String::new();
    for (i, c) in camel.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            s.push('_');
        }
        s.push(c.to_ascii_lowercase());
    }
    s
}

fn sev(s: &Severity) -> &'static str {
    match s {
        Severity::Critical => "CRITICAL",
        Severity::High => "HIGH    ",
        Severity::Medium => "MEDIUM  ",
        Severity::Low => "LOW     ",
    }
}

fn kinds(k: &[Kind]) -> String {
    k.iter().map(|k| format!("{k:?}").to_lowercase()).collect::<Vec<_>>().join(", ")
}

pub fn scan(r: &Report) {
    if r.exposed_entries == 0 {
        println!("✓ No standing path from any of {} entry points to a critical action.", r.entries);
    } else {
        println!("✗ {} of {} entry points can reach a critical action through standing access alone.\n", r.exposed_entries, r.entries);
    }
    for f in &r.findings {
        if let Finding::ExposedPath { severity, entry, reaches, kinds: k, path, fix, .. } = f {
            let mut hops: Vec<&str> = path.iter().map(|h| h.to.as_str()).collect();
            let many = reaches.len() > 1;
            let label = format!("{} critical resources", reaches.len());
            if many {
                hops.pop();
                hops.push(&label);
            }
            println!("{}  {entry} → {}  ({})", sev(severity), hops.join(" → "), kinds(k));
            for h in &path[..path.len() - usize::from(many)] {
                println!("          {} → {}: {}", h.from, h.to, h.via);
            }
            if many {
                println!("          reaches: {}", reaches.join(", "));
            }
            println!("          fix: {fix}");
            println!();
        }
    }
    // Guardrails: group by what's missing so 11 wallets read as one line.
    let mut missing: BTreeMap<(String, String), (Severity, Vec<&str>)> = BTreeMap::new();
    for f in &r.findings {
        if let Finding::MissingGuardrail { severity, resource, guardrail, fix } = f {
            missing
                .entry((guardrail_name(*guardrail).into(), fix.clone()))
                .or_insert_with(|| (severity.clone(), Vec::new()))
                .1
                .push(resource);
        }
    }
    if !missing.is_empty() {
        println!("Missing guardrails");
        let mut rows: Vec<_> = missing.into_iter().collect();
        rows.sort_by(|a, b| b.1.0.cmp(&a.1.0));
        for ((name, fix), (severity, resources)) in rows {
            println!("{}  {name} on {}: {}", sev(&severity), count(&resources), resources.join(", "));
            println!("          fix: {fix}");
        }
    }
}

fn count(r: &[&str]) -> String {
    if r.len() == 1 { "1 resource".into() } else { format!("{} resources", r.len()) }
}

fn guardrail_name(g: Guardrail) -> &'static str {
    match g {
        Guardrail::Policy => "no policy",
        Guardrail::Grants => "standing access",
        Guardrail::NoDelegation => "delegation allowed",
        Guardrail::DestinationAllowlist => "no destination allowlist",
        Guardrail::ApprovalThreshold => "no approval threshold",
        Guardrail::ValueCeiling => "no value ceiling",
    }
}

pub fn triage(t: &Triage) {
    println!("\nTriage ({}), severity {:?}", t.source, t.severity);
    println!("  {}", t.summary);
    if !t.attack_story.is_empty() {
        println!("  Likely attack: {}", t.attack_story);
    }
    println!("  Proposed responses (proposals only: the policy engine and a human decide):");
    for (i, p) in t.proposals.iter().enumerate() {
        let human = if p.response.needs_human() { "  [needs human]" } else { "" };
        println!("  {}. {} {}{human}", i + 1, snake(&format!("{:?}", p.response)), p.target);
        println!("     {}", p.why);
    }
}
