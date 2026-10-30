//! Shared types for Sikrets Autonomous.
//!
//! Everything on the decision hot path is a small integer: names are interned once when a policy
//! or graph is loaded, so evaluating an action never touches a string or the heap.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

macro_rules! id {
    ($($name:ident),*) => {$(
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub struct $name(pub u32);
        impl $name {
            #[inline(always)]
            pub const fn index(self) -> usize { self.0 as usize }
        }
    )*};
}
id!(PrincipalId, DeviceId, ResourceId, DestinationId, GrantId);

/// Unix time in milliseconds.
pub type Millis = u64;

/// What an action does to a resource. One bit each, so a rule's allowed set is a `u16` mask.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Kind {
    Read = 0,
    Write = 1,
    /// Moves value out (a withdrawal, a payment, a transfer).
    Transfer = 2,
    /// Hands control of the resource to code or a party (EIP-7702 authorization, OAuth consent, IAM trust).
    Delegate = 3,
    /// Produces a signature with the resource's key.
    Sign = 4,
    /// Changes who can do what.
    Admin = 5,
}

impl Kind {
    pub const ALL: [Kind; 6] = [Kind::Read, Kind::Write, Kind::Transfer, Kind::Delegate, Kind::Sign, Kind::Admin];
    #[inline(always)]
    pub const fn bit(self) -> u16 {
        1 << self as u8
    }
}

/// A set of [`Kind`]s.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Kinds(pub u16);

impl Kinds {
    #[inline(always)]
    pub const fn contains(self, k: Kind) -> bool {
        self.0 & k.bit() != 0
    }
    pub fn of(kinds: &[Kind]) -> Self {
        Kinds(kinds.iter().fold(0, |m, k| m | k.bit()))
    }
    /// Kinds that move value or control out of a resource.
    pub const MOVES_VALUE: Kinds = Kinds(Kind::Transfer.bit() | Kind::Delegate.bit() | Kind::Sign.bit());
    pub const fn intersects(self, other: Kinds) -> bool {
        self.0 & other.0 != 0
    }
}

/// Device health as last reported by the endpoint sensor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Posture {
    Healthy = 0,
    #[default]
    Unknown = 1,
    Suspicious = 2,
    Compromised = 3,
}

/// One request to do something. `Copy`, 40 bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Action {
    pub at: Millis,
    /// Value moved, in US cents (0 when nothing moves).
    pub usd_cents: u64,
    pub principal: PrincipalId,
    pub device: DeviceId,
    pub resource: ResourceId,
    /// For transfers: where value goes. For delegations: the code or party receiving control.
    pub destination: Option<DestinationId>,
    pub grant: Option<GrantId>,
    pub kind: Kind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Reason {
    UnknownResource = 1,
    KindNotAllowed = 2,
    NoGrant = 3,
    GrantExpired = 4,
    GrantMismatch = 5,
    DevicePosture = 6,
    DestinationNotAllowed = 7,
    CeilingExceeded = 8,
    Frozen = 9,
    NeedsApproval = 10,
    GrantRevoked = 11,
}

impl Reason {
    pub const fn describe(self) -> &'static str {
        match self {
            Reason::UnknownResource => "resource has no policy",
            Reason::KindNotAllowed => "this kind of action is never allowed on this resource",
            Reason::NoGrant => "no access grant; standing access is not allowed here",
            Reason::GrantExpired => "the access grant has expired",
            Reason::GrantMismatch => "the access grant doesn't cover this principal, resource or action",
            Reason::DevicePosture => "the device isn't healthy enough for this resource",
            Reason::DestinationNotAllowed => "destination is not on the allowlist",
            Reason::CeilingExceeded => "value ceiling for this window would be exceeded; resource frozen",
            Reason::Frozen => "resource is frozen after a ceiling breach",
            Reason::NeedsApproval => "above the approval threshold; a human must approve",
            Reason::GrantRevoked => "the access grant was revoked",
        }
    }
}

/// The outcome of evaluating an [`Action`]. Only `Allow` lets anything happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Decision {
    Allow,
    Deny(Reason),
    /// Not denied, but held until a human approves (detection tier 4).
    Escalate(Reason),
}

impl Decision {
    #[inline(always)]
    pub const fn allowed(self) -> bool {
        matches!(self, Decision::Allow)
    }
    pub const fn code(self) -> u8 {
        match self {
            Decision::Allow => 0,
            Decision::Deny(r) => r as u8,
            Decision::Escalate(r) => 0x80 | r as u8,
        }
    }
    pub const fn reason(self) -> Option<Reason> {
        match self {
            Decision::Allow => None,
            Decision::Deny(r) | Decision::Escalate(r) => Some(r),
        }
    }
}

/// Maps names to dense ids. Used at load time only.
#[derive(Debug, Default, Clone)]
pub struct Interner {
    ids: HashMap<String, u32>,
    names: Vec<String>,
}

impl Interner {
    pub fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = self.names.len() as u32;
        self.names.push(name.to_owned());
        self.ids.insert(name.to_owned(), id);
        id
    }
    pub fn get(&self, name: &str) -> Option<u32> {
        self.ids.get(name).copied()
    }
    pub fn name(&self, id: u32) -> &str {
        &self.names[id as usize]
    }
    pub fn len(&self) -> usize {
        self.names.len()
    }
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// Parses "45m", "2h", "30s", "1d" into milliseconds.
pub fn parse_duration(text: &str) -> Option<Millis> {
    let (n, unit) = text.split_at(text.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = n.parse().ok()?;
    let per = match unit {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return None,
    };
    n.checked_mul(per)
}

/// Parses "$50,000,000" / "50000000" / "50m" / "1.5b" dollars into cents.
pub fn parse_usd(text: &str) -> Option<u64> {
    let t: String = text.trim().trim_start_matches('$').chars().filter(|&c| c != ',' && c != '_').collect();
    let (num, mult) = match t.chars().last()? {
        'k' | 'K' => (&t[..t.len() - 1], 1e3),
        'm' | 'M' => (&t[..t.len() - 1], 1e6),
        'b' | 'B' => (&t[..t.len() - 1], 1e9),
        _ => (&t[..], 1.0),
    };
    let dollars: f64 = num.parse().ok()?;
    let cents = (dollars * mult * 100.0).round();
    (cents.is_finite() && cents >= 0.0 && cents < u64::MAX as f64).then_some(cents as u64)
}

pub fn format_usd(cents: u64) -> String {
    let d = cents as f64 / 100.0;
    match d {
        d if d >= 1e9 => format!("${:.2}B", d / 1e9),
        d if d >= 1e6 => format!("${:.1}M", d / 1e6),
        d if d >= 1e3 => format!("${:.1}K", d / 1e3),
        d => format!("${d:.2}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hot_types_stay_small() {
        assert_eq!(size_of::<Action>(), 48);
        assert_eq!(size_of::<Decision>(), 2);
    }

    #[test]
    fn parses_units() {
        assert_eq!(parse_duration("45m"), Some(2_700_000));
        assert_eq!(parse_duration("1d"), Some(86_400_000));
        assert_eq!(parse_duration("10"), None);
        assert_eq!(parse_usd("$50m"), Some(5_000_000_000));
        assert_eq!(parse_usd("1,000"), Some(100_000));
        assert_eq!(parse_usd("1.5b"), Some(150_000_000_000));
        assert_eq!(format_usd(636_000_000_000), "$6.36B");
    }

    #[test]
    fn decision_codes_are_distinct() {
        assert_eq!(Decision::Allow.code(), 0);
        assert_ne!(Decision::Deny(Reason::NeedsApproval).code(), Decision::Escalate(Reason::NeedsApproval).code());
    }
}
