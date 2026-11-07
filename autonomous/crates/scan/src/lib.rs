//! Proactive exposure scan: find the attack path before an attacker does.
//!
//! Input is an access graph: who or what can act on what, and whether that access is standing
//! (always on) or granted per use. An attacker who compromises an entry point (a laptop, a CI
//! runner, a package, a human account) inherits every standing edge reachable from it. The scan
//! finds every entry point with a standing path to an action that moves value or control out of a
//! critical resource, and proposes the cut that closes it.
//!
//! One reverse breadth-first search from all critical edges gives every node's shortest path to
//! harm in O(nodes + edges). A policy that requires grants on a resource removes standing edges
//! into it, so applying a fix and re-scanning shows the path is gone.

use serde::{Deserialize, Serialize};
use sikrets_core::{Kind, Kinds};
use sikrets_policy::Engine;
use std::collections::{BTreeMap, VecDeque};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Graph {
    pub nodes: BTreeMap<String, Node>,
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Human,
    Device,
    Ci,
    Package,
    Service,
    Resource,
}

impl NodeType {
    /// Things attackers compromise directly.
    pub fn is_entry(self) -> bool {
        matches!(self, NodeType::Human | NodeType::Device | NodeType::Ci | NodeType::Package)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    #[serde(rename = "type")]
    pub kind: NodeType,
    /// Holds or moves value: a hot wallet, a payments account, production data.
    #[serde(default)]
    pub critical: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub from: String,
    pub to: String,
    /// How: "kubectl exec", "signing API", "IAM role".
    pub via: String,
    /// What `from` can make `to` do (for resources) or do as `to` (for services).
    pub kinds: Vec<Kind>,
    /// Always on, no per-use grant.
    #[serde(default = "yes")]
    pub standing: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hop {
    pub from: String,
    pub to: String,
    pub via: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "finding", rename_all = "snake_case")]
pub enum Finding {
    /// An entry point can reach a value-moving action through standing access alone.
    ExposedPath {
        severity: Severity,
        entry: String,
        resource: String,
        /// Every critical resource the path's last hop can act on, `resource` included.
        reaches: Vec<String>,
        kinds: Vec<Kind>,
        path: Vec<Hop>,
        fix: String,
    },
    /// A critical resource lacks a guardrail that would cap the damage if a path is used.
    MissingGuardrail { severity: Severity, resource: String, guardrail: Guardrail, fix: String },
}

impl Finding {
    pub fn severity(&self) -> &Severity {
        match self {
            Finding::ExposedPath { severity, .. } | Finding::MissingGuardrail { severity, .. } => severity,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Guardrail {
    Policy,
    Grants,
    NoDelegation,
    DestinationAllowlist,
    ApprovalThreshold,
    ValueCeiling,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// Entry points with a standing path to harm. The number to drive to zero.
    pub exposed_entries: usize,
    pub entries: usize,
    pub findings: Vec<Finding>,
}

/// A [`Graph`] with names resolved to dense ids. Build once; scan as often as policy changes.
pub struct AccessGraph {
    graph: Graph,
    names: Vec<String>,
    from: Vec<u32>,
    to: Vec<u32>,
    kinds: Vec<Kinds>,
}

impl AccessGraph {
    pub fn new(graph: Graph) -> Result<Self, String> {
        let names: Vec<String> = graph.nodes.keys().cloned().collect();
        let ids: foldhash::HashMap<&str, u32> = names.iter().enumerate().map(|(i, n)| (n.as_str(), i as u32)).collect();
        let id = |n: &str| ids.get(n).copied().ok_or_else(|| format!("edge names unknown node \"{n}\""));
        let mut from = Vec::with_capacity(graph.edges.len());
        let mut to = Vec::with_capacity(graph.edges.len());
        for e in &graph.edges {
            from.push(id(&e.from)?);
            to.push(id(&e.to)?);
        }
        let kinds = graph.edges.iter().map(|e| Kinds::of(&e.kinds)).collect();
        drop(ids);
        Ok(Self { graph, names, from, to, kinds })
    }

    pub fn graph(&self) -> &Graph {
        &self.graph
    }
}

impl TryFrom<Graph> for AccessGraph {
    type Error = String;
    fn try_from(g: Graph) -> Result<Self, String> {
        Self::new(g)
    }
}

/// Reverse adjacency over the edges an attacker can traverse, in CSR form: incoming open edges of
/// node v are `edges[start[v]..start[v + 1]]`.
struct Reverse {
    start: Vec<u32>,
    edges: Vec<u32>,
}

fn reverse(g: &AccessGraph, policy: Option<&Engine>) -> Reverse {
    let n = g.names.len();
    // An edge is traversable by an attacker only if it's standing and its target's policy doesn't
    // demand a grant. Resolved per node, not per edge.
    let gated: Vec<bool> = match policy {
        Some(p) => g.names.iter().map(|name| p.resource(name).and_then(|r| p.rule(r)).is_some_and(|r| r.requires_grant())).collect(),
        None => vec![false; n],
    };
    let open = |i: usize| g.graph.edges[i].standing && !gated[g.to[i] as usize];
    let mut start = vec![0u32; n + 1];
    for (i, &t) in g.to.iter().enumerate() {
        if open(i) {
            start[t as usize + 1] += 1;
        }
    }
    for i in 0..n {
        start[i + 1] += start[i];
    }
    let mut fill = start.clone();
    let mut edges = vec![0u32; start[n] as usize];
    for (i, &t) in g.to.iter().enumerate() {
        if open(i) {
            edges[fill[t as usize] as usize] = i as u32;
            fill[t as usize] += 1;
        }
    }
    Reverse { start, edges }
}

const HARMFUL: Kinds = Kinds(Kinds::MOVES_VALUE.0 | Kind::Admin.bit());

pub fn scan(ag: &AccessGraph, policy: Option<&Engine>) -> Report {
    let g = &ag.graph;
    let nodes: Vec<&Node> = g.nodes.values().collect();
    let rev = reverse(ag, policy);
    let n = ag.names.len();
    const NONE: u32 = u32::MAX;
    // next[v] = the edge v takes one step toward harm; dist[v] = steps.
    let mut next = vec![NONE; n];
    let mut dist = vec![u32::MAX; n];
    // Which critical resource and kinds each node's path ends at.
    let mut target = vec![NONE; n];
    let mut queue = VecDeque::new();

    // Seeds: sources of standing harmful edges into critical resources.
    for (v, node) in nodes.iter().enumerate() {
        if !node.critical {
            continue;
        }
        for &e in &rev.edges[rev.start[v] as usize..rev.start[v + 1] as usize] {
            if !ag.kinds[e as usize].intersects(HARMFUL) {
                continue;
            }
            let u = ag.from[e as usize] as usize;
            if dist[u] > 1 {
                dist[u] = 1;
                next[u] = e;
                target[u] = e;
                queue.push_back(u as u32);
            }
        }
    }
    // Reverse BFS: anyone who can act as u can do what u does.
    while let Some(u) = queue.pop_front() {
        let u = u as usize;
        for &e in &rev.edges[rev.start[u] as usize..rev.start[u + 1] as usize] {
            let w = ag.from[e as usize] as usize;
            if dist[w] == u32::MAX {
                dist[w] = dist[u] + 1;
                next[w] = e;
                target[w] = target[u];
                queue.push_back(w as u32);
            }
        }
    }

    // Critical resources each node acts on directly through an open harmful edge.
    let mut reaches: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (v, node) in nodes.iter().enumerate() {
        if node.critical {
            for &e in &rev.edges[rev.start[v] as usize..rev.start[v + 1] as usize] {
                if ag.kinds[e as usize].intersects(HARMFUL) {
                    reaches[ag.from[e as usize] as usize].push(v as u32);
                }
            }
        }
    }

    let mut findings = Vec::new();
    let mut entries = 0;
    let mut exposed = 0;
    for v in 0..n {
        if !nodes[v].kind.is_entry() {
            continue;
        }
        entries += 1;
        if dist[v] == u32::MAX {
            continue;
        }
        exposed += 1;
        let mut path = Vec::new();
        let mut at = v;
        while next[at] != NONE {
            let e = next[at] as usize;
            path.push(Hop { from: ag.names[at].clone(), to: ag.names[ag.to[e] as usize].clone(), via: g.edges[e].via.clone() });
            at = ag.to[e] as usize;
            if nodes[at].critical {
                break;
            }
        }
        let last = &g.edges[target[v] as usize];
        let kinds: Vec<Kind> = last.kinds.iter().copied().filter(|k| HARMFUL.contains(*k)).collect();
        // Cut nearest the critical resource: one grant requirement there closes every path
        // through it, not just this one.
        // And cut the first standing hop out of a machine (a human logging into their own laptop
        // isn't the problem; the laptop's standing production access is).
        let mut reached: Vec<String> =
            reaches[ag.from[target[v] as usize] as usize].iter().map(|&r| ag.names[r as usize].clone()).collect();
        reached.sort();
        let target_text = if reached.len() > 1 { format!("{} critical resources", reached.len()) } else { last.to.clone() };
        let machine_hop = path[..path.len() - 1].iter().find(|h| g.nodes.get(&h.from).is_some_and(|n| n.kind != NodeType::Human));
        let fix = match machine_hop {
            Some(h) => format!(
                "Require a time-limited grant for {} → {target_text} ({}), and for {} → {} ({}).",
                last.from, last.via, h.from, h.to, h.via
            ),
            None => format!("Require a time-limited grant for {} → {target_text} ({}).", last.from, last.via),
        };
        findings.push(Finding::ExposedPath {
            severity: if dist[v] <= 3 { Severity::Critical } else { Severity::High },
            entry: ag.names[v].clone(),
            resource: last.to.clone(),
            reaches: reached,
            kinds,
            path,
            fix,
        });
    }

    for (v, node) in nodes.iter().enumerate() {
        if node.critical && node.kind == NodeType::Resource {
            guardrails(&ag.names[v], policy, &mut findings);
        }
    }
    findings.sort_by(|a, b| b.severity().cmp(a.severity()));
    Report { exposed_entries: exposed, entries, findings }
}

fn guardrails(resource: &str, policy: Option<&Engine>, out: &mut Vec<Finding>) {
    let mut missing = |guardrail, severity, fix: &str| {
        out.push(Finding::MissingGuardrail { severity, resource: resource.into(), guardrail, fix: fix.into() });
    };
    let Some(rule) = policy.and_then(|p| p.resource(resource).and_then(|r| p.rule(r))) else {
        missing(
            Guardrail::Policy,
            Severity::Critical,
            "Put this resource behind the policy gateway; today nothing checks what it's asked to do.",
        );
        return;
    };
    if !rule.requires_grant() {
        missing(Guardrail::Grants, Severity::High, "Set requires_grant: access only through time-limited grants.");
    }
    if rule.allows().contains(Kind::Delegate) {
        missing(
            Guardrail::NoDelegation,
            Severity::Critical,
            "Remove \"delegate\" from allow: a hot wallet should never hand control to other code.",
        );
    }
    let moves = rule.allows().contains(Kind::Transfer) || rule.allows().contains(Kind::Delegate);
    if moves && !rule.has_destination_allowlist() {
        missing(Guardrail::DestinationAllowlist, Severity::High, "Add a destinations allowlist (cold storage, user withdrawal routes).");
    }
    if moves && rule.approval_threshold().is_none() {
        missing(Guardrail::ApprovalThreshold, Severity::Medium, "Add approval_over so single large transfers wait for a human.");
    }
    if moves && !rule.has_ceiling() {
        missing(Guardrail::ValueCeiling, Severity::High, "Add ceilings (value per window) so a burst freezes the resource.");
    }
}

#[cfg(test)]
mod tests;
