//! sikrets-auto: proactive scan, attack replay and evidence ledger.

mod replay;
mod report;

use clap::{Parser, Subcommand};
use ed25519_dalek::VerifyingKey;
use sikrets_audit::{Item, Namespace, read};
use sikrets_core::format_usd;
use sikrets_policy::Engine;
use sikrets_scan::{AccessGraph, Graph, scan};
use sikrets_triage::{Gemini, Reasoner, fallback};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "sikrets-auto",
    version,
    about = "Find attack paths before attackers do, gate every consequential action, and keep tamper-evident evidence"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Find every standing path from something an attacker can compromise to an action that moves value
    Scan {
        /// Access graph (JSON)
        graph: PathBuf,
        /// Policy to check the graph against; without it every critical resource is unguarded
        #[arg(long)]
        policy: Option<PathBuf>,
        /// Ask the model to explain the attack and propose responses (it never acts)
        #[arg(long)]
        triage: bool,
        /// Machine-readable output
        #[arg(long)]
        json: bool,
    },
    /// Replay an attack timeline through the policy gateway, layer by layer
    Replay {
        /// Scenario directory with timeline.json, policy-as-was.json and policy.json
        scenario: PathBuf,
        /// Where ledgers are written
        #[arg(long, default_value = "out")]
        out: PathBuf,
    },
    /// Inspect a decision ledger
    Ledger {
        #[command(subcommand)]
        command: LedgerCommand,
    },
}

#[derive(Subcommand)]
enum LedgerCommand {
    /// Check every hash and checkpoint signature
    Verify {
        file: PathBuf,
        /// Public key, hex (written next to the ledger as ledger.pub)
        #[arg(long)]
        key: Option<String>,
    },
    /// Print every decision with names, oldest first
    Show {
        file: PathBuf,
        #[arg(long)]
        key: Option<String>,
        /// Only denied or held decisions
        #[arg(long)]
        blocked: bool,
    },
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("sikrets-auto: {e}");
            ExitCode::from(1)
        }
    }
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Command::Scan { graph, policy, triage, json } => {
            let g: Graph = serde_json::from_str(&std::fs::read_to_string(&graph)?)?;
            let g = AccessGraph::new(g)?;
            let policy = policy
                .map(|p| Engine::from_json(&std::fs::read_to_string(p)?).map_err(|e| Box::new(e) as Box<dyn std::error::Error>))
                .transpose()?;
            let rep = scan(&g, policy.as_ref());
            let tri = if triage { Some(triage_report(&rep)) } else { None };
            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({ "scan": rep, "triage": tri }))?);
            } else {
                report::scan(&rep);
                if let Some(t) = &tri {
                    report::triage(t);
                }
            }
            // Non-zero when anything is exposed, so CI can gate on it.
            Ok(if rep.exposed_entries > 0 { ExitCode::from(3) } else { ExitCode::SUCCESS })
        }
        Command::Replay { scenario, out } => {
            replay::run(&scenario, &out)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Ledger { command } => ledger(command),
    }
}

fn triage_report(rep: &sikrets_scan::Report) -> sikrets_triage::Triage {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let attempt = Gemini::from_env().map(|g| {
        eprintln!("Asking {} to triage…", g.model());
        rt.block_on(g.triage(rep))
    });
    match attempt {
        Ok(Ok(t)) => t,
        Ok(Err(e)) | Err(e) => {
            eprintln!("Model unavailable ({e}); using the scan's own fixes.");
            fallback(rep)
        }
    }
}

fn key_for(file: &Path, key: Option<String>) -> Result<VerifyingKey> {
    let hex = match key {
        Some(k) => k,
        None => {
            std::fs::read_to_string(file.with_file_name("ledger.pub")).map_err(|_| "pass --key, or keep ledger.pub next to the ledger")?
        }
    };
    let bytes = unhex(hex.trim()).ok_or("key is not 64 hex characters")?;
    Ok(VerifyingKey::from_bytes(&bytes)?)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    if s.len() != 64 {
        return None;
    }
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn ledger(command: LedgerCommand) -> Result<ExitCode> {
    match command {
        LedgerCommand::Verify { file, key } => {
            let rep = sikrets_audit::verify(&file, &key_for(&file, key)?)?;
            match &rep.problem {
                None => {
                    println!(
                        "✓ intact: {} decisions, {} signed checkpoints, signed through decision {}",
                        rep.decisions, rep.checkpoints, rep.signed_through
                    );
                    println!("  head {}", hex(&rep.head));
                    Ok(ExitCode::SUCCESS)
                }
                Some(p) => {
                    println!("✗ {p}");
                    println!("  {} decisions verified before the break", rep.decisions);
                    Ok(ExitCode::from(4))
                }
            }
        }
        LedgerCommand::Show { file, key, blocked } => {
            let mut names: [Vec<String>; 4] = Default::default();
            let name = |names: &[Vec<String>; 4], ns: Namespace, id: u32| {
                names[ns as usize].get(id as usize).cloned().unwrap_or_else(|| format!("#{id}"))
            };
            let rep = read(&file, &key_for(&file, key)?, |item| match item {
                Item::Name { namespace, id, name } => {
                    let v = &mut names[namespace as usize];
                    if v.len() <= id as usize {
                        v.resize(id as usize + 1, String::new());
                    }
                    v[id as usize] = name.to_owned();
                }
                Item::Decision(e) => {
                    let code = e.decision_code;
                    if blocked && code == 0 {
                        return;
                    }
                    let a = e.action;
                    let when =
                        jiff::Timestamp::from_millisecond(a.at as i64).map(|t| t.strftime("%H:%M:%S").to_string()).unwrap_or_default();
                    let to = a.destination.map(|d| format!(" → {}", name(&names, Namespace::Destination, d.0))).unwrap_or_default();
                    println!(
                        "{:>5}  {when}  {:<30} {:<18} {:<9}{to}  {}  [{}]",
                        e.seq,
                        report::outcome(code),
                        name(&names, Namespace::Resource, a.resource.0),
                        format!("{:?}", a.kind).to_lowercase(),
                        if a.usd_cents > 0 { format_usd(a.usd_cents) } else { String::new() },
                        name(&names, Namespace::Principal, a.principal.0),
                    );
                }
            })?;
            if let Some(p) = rep.problem {
                println!("✗ stopped: {p}");
                return Ok(ExitCode::from(4));
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}
