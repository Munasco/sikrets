//! The deterministic policy engine: the only thing that can say yes.
//!
//! Models propose; this decides. Evaluation is branch-light integer work over dense arrays:
//! no strings, no allocation, no locks, no I/O. A policy is compiled once from JSON into
//! per-resource [`Rule`]s; grants and device posture change at runtime.
//!
//! Order of checks, cheapest and most absolute first:
//! frozen → kind → grant → device posture → destination → approval threshold → value ceilings.
//! A ceiling breach freezes the resource, so a burst of withdrawals stops at the first one over.

mod window;

use serde::Deserialize;
use sikrets_core::*;
use std::collections::BTreeMap;
pub use window::Window;

/// Policy as written by people. Compiled into an [`Engine`].
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub resources: BTreeMap<String, ResourcePolicy>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourcePolicy {
    /// Kinds of action ever allowed. Anything else is denied outright.
    pub allow: Vec<Kind>,
    /// When true, every action needs a live, matching grant: no standing access.
    #[serde(default)]
    pub requires_grant: bool,
    /// Worst device posture still allowed to act. Default: healthy only.
    #[serde(default)]
    pub min_posture: MinPosture,
    /// Where transfers and delegations may go. Absent: anywhere.
    #[serde(default)]
    pub destinations: Option<Vec<String>>,
    /// A single action above this value waits for a human, e.g. "$5m".
    #[serde(default)]
    pub approval_over: Option<String>,
    /// Rolling value limits, e.g. { "window": "10m", "max": "$50m" }.
    #[serde(default)]
    pub ceilings: Vec<CeilingPolicy>,
    /// How long the resource stays frozen after a ceiling breach. Default 1h.
    #[serde(default)]
    pub freeze_for: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MinPosture {
    #[default]
    Healthy,
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CeilingPolicy {
    pub window: String,
    pub max: String,
}

#[derive(Debug)]
pub enum PolicyError {
    Json(serde_json::Error),
    Invalid(String),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyError::Json(e) => write!(f, "policy JSON: {e}"),
            PolicyError::Invalid(m) => write!(f, "policy: {m}"),
        }
    }
}

impl std::error::Error for PolicyError {}

/// A resource's compiled rule.
#[derive(Debug, Clone)]
pub struct Rule {
    allow: Kinds,
    requires_grant: bool,
    worst_posture: Posture,
    /// Bitset over destination ids; `None` allows any destination.
    destinations: Option<Box<[u64]>>,
    approval_over: u64,
    windows: Box<[Window]>,
    freeze_ms: Millis,
    frozen_until: Millis,
}

impl Rule {
    pub fn allows(&self) -> Kinds {
        self.allow
    }
    pub fn requires_grant(&self) -> bool {
        self.requires_grant
    }
    pub fn has_destination_allowlist(&self) -> bool {
        self.destinations.is_some()
    }
    pub fn has_ceiling(&self) -> bool {
        !self.windows.is_empty()
    }
    pub fn approval_threshold(&self) -> Option<u64> {
        (self.approval_over != u64::MAX).then_some(self.approval_over)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Grant {
    pub principal: PrincipalId,
    pub resource: ResourceId,
    pub kinds: Kinds,
    pub not_after: Millis,
    pub revoked: bool,
}

/// Names for every id an [`Engine`] knows.
#[derive(Debug, Default, Clone)]
pub struct Names {
    pub principals: Interner,
    pub devices: Interner,
    pub resources: Interner,
    pub destinations: Interner,
}

pub struct Engine {
    pub names: Names,
    rules: Vec<Rule>,
    postures: Vec<Posture>,
    grants: Vec<Grant>,
}

const DEFAULT_FREEZE_MS: Millis = 3_600_000;

impl Engine {
    pub fn from_json(json: &str) -> Result<Self, PolicyError> {
        Self::compile(&serde_json::from_str(json).map_err(PolicyError::Json)?)
    }

    pub fn compile(policy: &Policy) -> Result<Self, PolicyError> {
        let mut names = Names::default();
        // Intern every destination first so each rule's bitset has its final width.
        for r in policy.resources.values() {
            for d in r.destinations.iter().flatten() {
                names.destinations.intern(d);
            }
        }
        let words = names.destinations.len().div_ceil(64).max(1);
        let mut rules = Vec::with_capacity(policy.resources.len());
        for (name, r) in &policy.resources {
            let bad = |what: &str| PolicyError::Invalid(format!("{name}: {what}"));
            names.resources.intern(name);
            let destinations = r.destinations.as_ref().map(|ds| {
                let mut bits = vec![0u64; words].into_boxed_slice();
                for d in ds {
                    let id = names.destinations.get(d).expect("interned above") as usize;
                    bits[id / 64] |= 1 << (id % 64);
                }
                bits
            });
            let approval_over = match &r.approval_over {
                Some(t) => parse_usd(t).ok_or_else(|| bad("approval_over is not an amount"))?,
                None => u64::MAX,
            };
            let windows = r
                .ceilings
                .iter()
                .map(|c| {
                    let span = parse_duration(&c.window).filter(|&s| s > 0).ok_or_else(|| bad("ceiling window is not a duration"))?;
                    let max = parse_usd(&c.max).ok_or_else(|| bad("ceiling max is not an amount"))?;
                    Ok(Window::new(span, max))
                })
                .collect::<Result<Vec<_>, PolicyError>>()?
                .into_boxed_slice();
            let freeze_ms = match &r.freeze_for {
                Some(t) => parse_duration(t).ok_or_else(|| bad("freeze_for is not a duration"))?,
                None => DEFAULT_FREEZE_MS,
            };
            rules.push(Rule {
                allow: Kinds::of(&r.allow),
                requires_grant: r.requires_grant,
                worst_posture: match r.min_posture {
                    MinPosture::Healthy => Posture::Healthy,
                    MinPosture::Unknown => Posture::Unknown,
                },
                destinations,
                approval_over,
                windows,
                freeze_ms,
                frozen_until: 0,
            });
        }
        Ok(Self { names, rules, postures: Vec::new(), grants: Vec::new() })
    }

    pub fn rule(&self, r: ResourceId) -> Option<&Rule> {
        self.rules.get(r.index())
    }

    pub fn resource(&self, name: &str) -> Option<ResourceId> {
        self.names.resources.get(name).map(ResourceId)
    }

    /// Interns a principal, device or destination seen at runtime. Unknown destinations get ids
    /// beyond every allowlist's bitset, so they are never allowed by one.
    pub fn principal(&mut self, name: &str) -> PrincipalId {
        PrincipalId(self.names.principals.intern(name))
    }
    pub fn device(&mut self, name: &str) -> DeviceId {
        DeviceId(self.names.devices.intern(name))
    }
    pub fn destination(&mut self, name: &str) -> DestinationId {
        DestinationId(self.names.destinations.intern(name))
    }

    pub fn set_posture(&mut self, device: DeviceId, posture: Posture) {
        let i = device.index();
        if i >= self.postures.len() {
            self.postures.resize(i + 1, Posture::Unknown);
        }
        self.postures[i] = posture;
    }

    pub fn posture(&self, device: DeviceId) -> Posture {
        self.postures.get(device.index()).copied().unwrap_or_default()
    }

    /// Issues a time-limited grant. Policy on whether to issue it is the caller's job; the engine
    /// only enforces it.
    pub fn grant(&mut self, principal: PrincipalId, resource: ResourceId, kinds: Kinds, not_after: Millis) -> GrantId {
        self.grants.push(Grant { principal, resource, kinds, not_after, revoked: false });
        GrantId(self.grants.len() as u32 - 1)
    }

    pub fn revoke(&mut self, grant: GrantId) -> bool {
        self.grants.get_mut(grant.index()).is_some_and(|g| !std::mem::replace(&mut g.revoked, true))
    }

    pub fn grant_info(&self, grant: GrantId) -> Option<Grant> {
        self.grants.get(grant.index()).copied()
    }

    /// Decides one action and, when it is allowed, counts its value against the ceilings.
    #[inline]
    pub fn evaluate(&mut self, a: &Action) -> Decision {
        self.decide(a, false)
    }

    /// For an action a human approved after an [`Decision::Escalate`]: every check still applies
    /// except the approval threshold.
    pub fn evaluate_approved(&mut self, a: &Action) -> Decision {
        self.decide(a, true)
    }

    #[inline]
    fn decide(&mut self, a: &Action, approved: bool) -> Decision {
        let Some(rule) = self.rules.get_mut(a.resource.index()) else {
            return Decision::Deny(Reason::UnknownResource);
        };
        if a.at < rule.frozen_until {
            return Decision::Deny(Reason::Frozen);
        }
        if !rule.allow.contains(a.kind) {
            return Decision::Deny(Reason::KindNotAllowed);
        }
        if rule.requires_grant {
            let Some(g) = a.grant.and_then(|g| self.grants.get(g.index())) else {
                return Decision::Deny(Reason::NoGrant);
            };
            if g.revoked {
                return Decision::Deny(Reason::GrantRevoked);
            }
            if g.principal != a.principal || g.resource != a.resource || !g.kinds.contains(a.kind) {
                return Decision::Deny(Reason::GrantMismatch);
            }
            if a.at >= g.not_after {
                return Decision::Deny(Reason::GrantExpired);
            }
        }
        let posture = self.postures.get(a.device.index()).copied().unwrap_or_default();
        if posture > rule.worst_posture {
            return Decision::Deny(Reason::DevicePosture);
        }
        if let Some(bits) = &rule.destinations
            && Kinds::MOVES_VALUE.contains(a.kind)
            && a.kind != Kind::Sign
        {
            let ok = a.destination.is_some_and(|d| {
                let i = d.index();
                bits.get(i / 64).is_some_and(|w| w & (1 << (i % 64)) != 0)
            });
            if !ok {
                return Decision::Deny(Reason::DestinationNotAllowed);
            }
        }
        if a.usd_cents == 0 {
            return Decision::Allow;
        }
        if !approved && a.usd_cents > rule.approval_over {
            return Decision::Escalate(Reason::NeedsApproval);
        }
        let mut over = false;
        for w in rule.windows.iter_mut() {
            w.advance(a.at);
            over |= w.would_exceed(a.usd_cents);
        }
        if over {
            rule.frozen_until = a.at.saturating_add(rule.freeze_ms);
            return Decision::Deny(Reason::CeilingExceeded);
        }
        for w in rule.windows.iter_mut() {
            w.add(a.at, a.usd_cents);
        }
        Decision::Allow
    }

    /// Lifts a freeze early (a human decided the burst was legitimate).
    pub fn unfreeze(&mut self, r: ResourceId) {
        if let Some(rule) = self.rules.get_mut(r.index()) {
            rule.frozen_until = 0;
        }
    }
}

#[cfg(test)]
mod tests;
