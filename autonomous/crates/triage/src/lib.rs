//! Security reasoning: a model reads findings and proposes responses. It never acts.
//!
//! The model gets names and structure only (who can reach what, which guardrail is missing),
//! never secret values. Its output is constrained to a JSON schema, and every proposal is one of
//! a fixed set of [`Response`]s that the deterministic side knows how to check and carry out.
//! When the model is unavailable, triage degrades to the scan's own fixes: protection doesn't
//! depend on a model being up.
//!
//! Providers sit behind [`Reasoner`]; Gemini today, others (e.g. DeepSeek on Azure) next.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sikrets_scan::{Finding, Report};
use std::time::Duration;

/// What the model may propose. Anything else fails schema validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Response {
    RequireGrant,
    RevokeGrant,
    FreezeResource,
    IsolateDevice,
    RotateCredentials,
    AddCeiling,
    RemoveDelegation,
    AddAllowlist,
    AddApprovalThreshold,
    NotifyHuman,
}

impl Response {
    pub const ALL: [Response; 10] = [
        Response::RequireGrant,
        Response::RevokeGrant,
        Response::FreezeResource,
        Response::IsolateDevice,
        Response::RotateCredentials,
        Response::AddCeiling,
        Response::RemoveDelegation,
        Response::AddAllowlist,
        Response::AddApprovalThreshold,
        Response::NotifyHuman,
    ];

    /// Disruptive responses always need a human (detection tier 4).
    pub fn needs_human(self) -> bool {
        matches!(self, Response::FreezeResource | Response::IsolateDevice | Response::RotateCredentials)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub response: Response,
    /// The node or resource it applies to; must exist in the scanned graph.
    pub target: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Triage {
    pub severity: Severity,
    pub summary: String,
    /// The single most likely attack, in plain words.
    pub attack_story: String,
    pub proposals: Vec<Proposal>,
    /// "model" or "fallback".
    #[serde(default)]
    pub source: String,
}

#[derive(Debug)]
pub enum TriageError {
    NoKey,
    Http(String),
    Model(String),
}

impl std::fmt::Display for TriageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TriageError::NoKey => write!(f, "no model key configured (set GEMINI_API_KEY)"),
            TriageError::Http(m) => write!(f, "model request failed: {m}"),
            TriageError::Model(m) => write!(f, "model returned something unusable: {m}"),
        }
    }
}

impl std::error::Error for TriageError {}

pub trait Reasoner {
    fn triage(&self, report: &Report) -> impl Future<Output = Result<Triage, TriageError>> + Send;
}

pub const DEFAULT_MODEL: &str = "gemini-4-argon";
const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";

pub struct Gemini {
    http: reqwest::Client,
    key: String,
    model: String,
}

impl Gemini {
    /// Reads GEMINI_API_KEY, and SIKRETS_MODEL to override the model.
    pub fn from_env() -> Result<Self, TriageError> {
        let key = std::env::var("GEMINI_API_KEY").map_err(|_| TriageError::NoKey)?;
        let model = std::env::var("SIKRETS_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| TriageError::Http(e.to_string()))?;
        Ok(Self { http, key, model })
    }

    pub fn model(&self) -> &str {
        &self.model
    }
}

const SYSTEM: &str = "You are the triage stage of Sikrets, a security agent. You receive an exposure scan: \
attack paths from things an attacker can compromise (laptops, CI runners, packages, accounts) to actions \
that move value or control, plus missing guardrails. Explain the most likely attack in two sentences a busy \
engineer understands, rate overall severity, and propose the smallest set of responses that closes every \
path, most important first. Only target nodes or resources named in the scan. You never act; a \
deterministic policy engine and a human decide.";

fn schema() -> serde_json::Value {
    let responses: Vec<String> = Response::ALL.iter().map(|r| serde_json::to_value(r).unwrap().as_str().unwrap().to_owned()).collect();
    json!({
        "type": "object",
        "properties": {
            "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
            "summary": { "type": "string" },
            "attack_story": { "type": "string" },
            "proposals": {
                "type": "array",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "response": { "type": "string", "enum": responses },
                        "target": { "type": "string" },
                        "why": { "type": "string" }
                    },
                    "required": ["response", "target", "why"]
                }
            }
        },
        "required": ["severity", "summary", "attack_story", "proposals"]
    })
}

impl Reasoner for Gemini {
    async fn triage(&self, report: &Report) -> Result<Triage, TriageError> {
        let scan = serde_json::to_string(report).map_err(|e| TriageError::Model(e.to_string()))?;
        let body = json!({
            "systemInstruction": { "parts": [{ "text": SYSTEM }] },
            "contents": [{ "role": "user", "parts": [{ "text": scan }] }],
            "generationConfig": { "responseMimeType": "application/json", "responseJsonSchema": schema() }
        });
        let res = self
            .http
            .post(format!("{ENDPOINT}/{}:generateContent", self.model))
            .header("x-goog-api-key", &self.key)
            .json(&body)
            .send()
            .await
            .map_err(|e| TriageError::Http(e.without_url().to_string()))?;
        let status = res.status();
        let v: serde_json::Value = res.json().await.map_err(|e| TriageError::Http(e.without_url().to_string()))?;
        if !status.is_success() {
            let msg = v["error"]["message"].as_str().unwrap_or("no message");
            return Err(TriageError::Http(format!("{status}: {msg}")));
        }
        let text: String =
            v["candidates"][0]["content"]["parts"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect();
        let mut t: Triage = serde_json::from_str(&text).map_err(|e| TriageError::Model(e.to_string()))?;
        t.source = "model".into();
        keep_known_targets(&mut t, report);
        Ok(t)
    }
}

/// Drops proposals aimed at anything the scan didn't name: a model can't invent a target.
fn keep_known_targets(t: &mut Triage, report: &Report) {
    let mut known = std::collections::HashSet::new();
    for f in &report.findings {
        match f {
            Finding::ExposedPath { entry, resource, path, .. } => {
                known.insert(entry.as_str());
                known.insert(resource.as_str());
                for h in path {
                    known.insert(h.from.as_str());
                    known.insert(h.to.as_str());
                }
            }
            Finding::MissingGuardrail { resource, .. } => {
                known.insert(resource.as_str());
            }
        }
    }
    t.proposals.retain(|p| known.contains(p.target.as_str()));
}

/// Triage without a model: the scan's own fixes, in severity order.
pub fn fallback(report: &Report) -> Triage {
    let mut proposals = Vec::new();
    for f in &report.findings {
        match f {
            Finding::ExposedPath { path, resource, .. } => {
                if let Some(last) = path.last() {
                    proposals.push(Proposal {
                        response: Response::RequireGrant,
                        target: last.to.clone(),
                        why: format!("standing path into {resource}"),
                    });
                }
            }
            Finding::MissingGuardrail { resource, guardrail, fix, .. } => {
                use sikrets_scan::Guardrail::*;
                let response = match guardrail {
                    Policy | Grants => Response::RequireGrant,
                    NoDelegation => Response::RemoveDelegation,
                    DestinationAllowlist => Response::AddAllowlist,
                    ApprovalThreshold => Response::AddApprovalThreshold,
                    ValueCeiling => Response::AddCeiling,
                };
                proposals.push(Proposal { response, target: resource.clone(), why: fix.clone() });
            }
        }
    }
    proposals.dedup_by(|a, b| a.response == b.response && a.target == b.target);
    let severity = if report.exposed_entries > 0 {
        Severity::Critical
    } else if report.findings.is_empty() {
        Severity::Low
    } else {
        Severity::High
    };
    Triage {
        severity,
        summary: format!("{} of {} entry points have a standing path to a critical action.", report.exposed_entries, report.entries),
        attack_story: String::new(),
        proposals,
        source: "fallback".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sikrets_scan::{AccessGraph, Graph, scan};

    fn report() -> Report {
        let g: Graph = serde_json::from_str(
            r#"{"nodes":{"laptop":{"type":"device"},"svc":{"type":"service"},"wallet":{"type":"resource","critical":true}},
                "edges":[{"from":"laptop","to":"svc","via":"ssh","kinds":["admin"]},
                         {"from":"svc","to":"wallet","via":"signer","kinds":["transfer","delegate"]}]}"#,
        )
        .unwrap();
        scan(&AccessGraph::new(g).unwrap(), None)
    }

    #[test]
    fn fallback_covers_every_finding() {
        let t = fallback(&report());
        assert_eq!(t.severity, Severity::Critical);
        assert!(t.proposals.iter().any(|p| p.response == Response::RequireGrant && p.target == "wallet"));
    }

    #[test]
    fn invented_targets_are_dropped() {
        let r = report();
        let mut t = fallback(&r);
        t.proposals.push(Proposal { response: Response::FreezeResource, target: "prod-db-that-isnt-there".into(), why: "x".into() });
        keep_known_targets(&mut t, &r);
        assert!(t.proposals.iter().all(|p| p.target != "prod-db-that-isnt-there"));
    }

    #[test]
    fn schema_lists_every_response() {
        let s = schema();
        assert_eq!(s["properties"]["proposals"]["items"]["properties"]["response"]["enum"].as_array().unwrap().len(), Response::ALL.len());
    }

    /// Calls the real model. Run with: cargo test -p sikrets-triage -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_model_triage() {
        let g = Gemini::from_env().unwrap();
        let t = g.triage(&report()).await.unwrap();
        assert!(!t.proposals.is_empty());
        assert_eq!(t.source, "model");
    }
}
