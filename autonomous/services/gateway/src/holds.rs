//! Actions held for a human (`Decision::Escalate`), keyed by the ledger seq of the hold decision.
//!
//! A hold is `Pending` until an admin approves or denies it, or it passes its deadline. The ledger
//! records the hold (its decision) and the resolution (an event), so a restart rebuilds this map.

use sikrets_core::{Action, Millis};
use std::collections::HashMap;

/// How long a held action waits for a human before it can no longer be approved.
pub const HOLD_TTL_MS: Millis = 3_600_000;
/// Settled and expired holds are dropped once the map grows past this.
const PRUNE_AT: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    Pending { action: Action, expires: Millis },
    Approved,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldError {
    Unknown,
    Expired,
    Settled,
}

#[derive(Debug, Default)]
pub struct Holds(HashMap<u64, Hold>);

impl Holds {
    /// Records a hold decided at `action.at`.
    pub fn open(&mut self, seq: u64, action: Action) {
        if self.0.len() >= PRUNE_AT {
            let now = action.at;
            self.0.retain(|_, h| matches!(h, Hold::Pending { expires, .. } if now < *expires));
        }
        self.0.insert(seq, Hold::Pending { action, expires: action.at.saturating_add(HOLD_TTL_MS) });
    }

    /// The held action, if `seq` can still be settled at `now`. Check this, write the resolution
    /// to the ledger, then [`Holds::settle`].
    pub fn pending(&self, seq: u64, now: Millis) -> Result<Action, HoldError> {
        match self.0.get(&seq) {
            None => Err(HoldError::Unknown),
            Some(Hold::Pending { action, expires }) if now < *expires => Ok(*action),
            Some(Hold::Pending { .. }) => Err(HoldError::Expired),
            Some(Hold::Approved | Hold::Denied) => Err(HoldError::Settled),
        }
    }

    /// The only way out of `Pending`. Refuses anything else, so a hold settles once.
    pub fn settle(&mut self, seq: u64, approved: bool) -> Result<(), HoldError> {
        let hold = self.0.get_mut(&seq).ok_or(HoldError::Unknown)?;
        match hold {
            Hold::Pending { .. } => {
                *hold = if approved { Hold::Approved } else { Hold::Denied };
                Ok(())
            }
            Hold::Approved | Hold::Denied => Err(HoldError::Settled),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sikrets_core::*;

    fn action(at: Millis) -> Action {
        Action {
            at,
            usd_cents: 1,
            principal: PrincipalId(0),
            device: DeviceId(0),
            resource: ResourceId(0),
            destination: None,
            grant: None,
            kind: Kind::Transfer,
        }
    }

    #[test]
    fn a_hold_settles_once_and_expires() {
        let mut h = Holds::default();
        h.open(7, action(1_000));
        assert_eq!(h.pending(7, 2_000), Ok(action(1_000)));
        assert_eq!(h.pending(7, 1_000 + HOLD_TTL_MS), Err(HoldError::Expired));
        assert_eq!(h.pending(8, 2_000), Err(HoldError::Unknown));
        h.settle(7, true).unwrap();
        assert_eq!(h.pending(7, 2_000), Err(HoldError::Settled));
        assert_eq!(h.settle(7, false), Err(HoldError::Settled));
    }
}
