//! Rebuilds gateway state from the ledger on start.
//!
//! Ids in the ledger are the ones each earlier run handed out, and a run numbers principals,
//! devices and runtime destinations in the order it first sees them (resources in policy order).
//! So nothing is replayed by id: every id goes back to its name through the name frames read so
//! far, then forward to this run's id.

use crate::holds::Holds;
use sikrets_audit::{Event, Item, Namespace};
use sikrets_core::*;
use sikrets_policy::{Engine, Grant};

pub struct Restore<'a> {
    engine: &'a mut Engine,
    holds: &'a mut Holds,
    /// The name each ledger id had at this point in the file, per namespace.
    names: [Vec<Option<String>>; 4],
}

impl<'a> Restore<'a> {
    pub fn new(engine: &'a mut Engine, holds: &'a mut Holds) -> Self {
        Self { engine, holds, names: Default::default() }
    }

    fn name(&self, ns: Namespace, id: u32) -> Option<&str> {
        self.names[ns as usize].get(id as usize)?.as_deref()
    }

    fn principal(&mut self, id: PrincipalId) -> Option<PrincipalId> {
        let name = self.names[Namespace::Principal as usize].get(id.index())?.as_deref()?;
        Some(self.engine.principal(name))
    }

    fn device(&mut self, id: DeviceId) -> Option<DeviceId> {
        let name = self.names[Namespace::Device as usize].get(id.index())?.as_deref()?;
        Some(self.engine.device(name))
    }

    fn resource(&self, id: ResourceId) -> Option<ResourceId> {
        self.engine.resource(self.name(Namespace::Resource, id.0)?)
    }

    fn destination(&mut self, id: DestinationId) -> Option<DestinationId> {
        let name = self.names[Namespace::Destination as usize].get(id.index())?.as_deref()?;
        Some(self.engine.destination(name))
    }

    pub fn apply(&mut self, item: Item<'_>) {
        match item {
            Item::Name { namespace, id, name } => {
                let Some(table) = self.names.get_mut(namespace as usize) else { return };
                let i = id as usize;
                if table.len() <= i {
                    table.resize(i + 1, None);
                }
                table[i] = Some(name.to_owned());
                // Keep earlier runs' numbering where it doesn't conflict.
                match namespace {
                    n if n == Namespace::Principal as u8 => {
                        self.engine.principal(name);
                    }
                    n if n == Namespace::Device as u8 => {
                        self.engine.device(name);
                    }
                    _ => {}
                }
            }
            Item::Decision(entry) => {
                // Resources that left the policy have no state to rebuild.
                let Some(resource) = self.resource(entry.action.resource) else { return };
                let Some(decision) = Decision::from_code(entry.decision_code) else { return };
                let mut action = Action { resource, ..entry.action };
                self.engine.replay(&action, decision);
                if let Decision::Escalate(_) = decision {
                    // A hold can only be approved if the whole action still maps.
                    let (Some(principal), Some(device)) = (self.principal(action.principal), self.device(action.device)) else {
                        return;
                    };
                    let destination = match action.destination {
                        Some(d) => match self.destination(d) {
                            Some(d) => Some(d),
                            None => return,
                        },
                        None => None,
                    };
                    action = Action { principal, device, destination, ..action };
                    self.holds.open(entry.seq, action);
                }
            }
            Item::Event(event) => self.event(event),
        }
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Grant { id, principal, resource, kinds, not_after, .. } => {
                // A grant whose principal or resource no longer maps stays void, but keeps its id.
                let grant = match (self.principal(principal), self.resource(resource)) {
                    (Some(principal), Some(resource)) => Grant { principal, resource, kinds, not_after, revoked: false },
                    _ => Grant::VOID,
                };
                self.engine.restore_grant(id, grant);
            }
            Event::Revoke { grant, .. } => {
                self.engine.revoke(grant);
            }
            Event::Posture { device, posture, .. } => {
                if let Some(d) = self.device(device) {
                    self.engine.set_posture(d, posture);
                }
            }
            Event::Unfreeze { resource, .. } => {
                if let Some(r) = self.resource(resource) {
                    self.engine.unfreeze(r);
                }
            }
            Event::Resolve { seq, approved, .. } => {
                // Unknown holds (their action no longer maps) have nothing to settle.
                let _ = self.holds.settle(seq, approved);
            }
        }
    }
}
