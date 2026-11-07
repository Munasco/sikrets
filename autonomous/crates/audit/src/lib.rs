//! Tamper-evident decision ledger.
//!
//! Every frame is chained: `hash = BLAKE3-keyed(key = previous hash, frame)`. Changing, removing or
//! reordering any frame breaks every hash after it. Checkpoints sign `(seq, hash)` with Ed25519,
//! so a verifier holding only the public key can tell the chain is the one the gateway wrote,
//! not a rebuilt forgery.
//!
//! The file is self-describing: the first time an id appears, a name frame records what it
//! stands for, inside the chain. If a later run gives the id to something else, a new name frame
//! rebinds it, so a reader that walks the file in order always has the right name. Evidence
//! exported from it reads without any other database.
//!
//! Gateway state that has to survive a restart (grants, revocations, device posture, early
//! unfreezes, hold resolutions) is written as event frames, so the ledger is the only thing a
//! restarted gateway needs to rebuild itself.
//!
//! Frame layout: `tag u8 ‖ body ‖ hash [u8; 32]`. Bodies have fixed sizes except names.

use ed25519_dalek::{Signature, Signer};
pub use ed25519_dalek::{SigningKey, VerifyingKey};
use sikrets_core::*;
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;

const TAG_DECISION: u8 = 1;
const TAG_CHECKPOINT: u8 = 2;
const TAG_NAME: u8 = 3;
const TAG_EVENT: u8 = 4;
const DECISION_BODY: usize = 48;
const CHECKPOINT_BODY: usize = 8 + 64;
const EVENT_BODY: usize = 32;
const NAME_HEAD: usize = 7;
const HASH: usize = 32;
/// The largest frame there is: a name frame with a `u16::MAX`-byte name. A torn tail shorter
/// than this can only be the one frame that was being written when the process died.
const MAX_FRAME: u64 = (1 + NAME_HEAD + u16::MAX as usize + HASH) as u64;
const NONE: u32 = u32::MAX;
/// Genesis value the chain starts from.
const GENESIS: [u8; 32] = [0; 32];

/// What a name frame names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Namespace {
    Principal = 0,
    Device = 1,
    Resource = 2,
    Destination = 3,
}

impl Namespace {
    pub const ALL: [Namespace; 4] = [Namespace::Principal, Namespace::Device, Namespace::Resource, Namespace::Destination];
}

/// A change to gateway state, recorded before it takes effect. Ids are the ones in force when
/// the event was written; a name frame for each precedes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Grant {
        at: Millis,
        id: GrantId,
        principal: PrincipalId,
        resource: ResourceId,
        kinds: Kinds,
        not_after: Millis,
    },
    Revoke {
        at: Millis,
        grant: GrantId,
    },
    Posture {
        at: Millis,
        device: DeviceId,
        posture: Posture,
    },
    /// A human lifted a ceiling freeze early.
    Unfreeze {
        at: Millis,
        resource: ResourceId,
    },
    /// A human approved or denied the action held at decision `seq`.
    Resolve {
        at: Millis,
        seq: u64,
        approved: bool,
    },
}

fn encode_event(e: &Event) -> [u8; EVENT_BODY] {
    let mut b = [0u8; EVENT_BODY];
    let (kind, at) = match *e {
        Event::Grant { at, id, principal, resource, kinds, not_after } => {
            b[9..13].copy_from_slice(&id.0.to_le_bytes());
            b[13..17].copy_from_slice(&principal.0.to_le_bytes());
            b[17..21].copy_from_slice(&resource.0.to_le_bytes());
            b[21..23].copy_from_slice(&kinds.0.to_le_bytes());
            b[23..31].copy_from_slice(&not_after.to_le_bytes());
            (1, at)
        }
        Event::Revoke { at, grant } => {
            b[9..13].copy_from_slice(&grant.0.to_le_bytes());
            (2, at)
        }
        Event::Posture { at, device, posture } => {
            b[9..13].copy_from_slice(&device.0.to_le_bytes());
            b[13] = posture as u8;
            (3, at)
        }
        Event::Unfreeze { at, resource } => {
            b[9..13].copy_from_slice(&resource.0.to_le_bytes());
            (4, at)
        }
        Event::Resolve { at, seq, approved } => {
            b[9..17].copy_from_slice(&seq.to_le_bytes());
            b[17] = approved as u8;
            (5, at)
        }
    };
    b[0] = kind;
    b[1..9].copy_from_slice(&at.to_le_bytes());
    b
}

fn decode_event(b: &[u8; EVENT_BODY]) -> Option<Event> {
    let u64_at = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
    let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let at = u64_at(1);
    Some(match b[0] {
        1 => Event::Grant {
            at,
            id: GrantId(u32_at(9)),
            principal: PrincipalId(u32_at(13)),
            resource: ResourceId(u32_at(17)),
            kinds: Kinds(u16::from_le_bytes([b[21], b[22]])),
            not_after: u64_at(23),
        },
        2 => Event::Revoke { at, grant: GrantId(u32_at(9)) },
        3 => Event::Posture { at, device: DeviceId(u32_at(9)), posture: Posture::from_code(b[13])? },
        4 => Event::Unfreeze { at, resource: ResourceId(u32_at(9)) },
        5 => Event::Resolve { at, seq: u64_at(9), approved: b[17] != 0 },
        _ => return None,
    })
}

/// Which name each id has right now, per namespace.
type NameTables = [Vec<Option<Box<str>>>; 4];

fn bind(tables: &mut NameTables, ns: usize, id: u32, name: &str) {
    if let Some(table) = tables.get_mut(ns) {
        let i = id as usize;
        if table.len() <= i {
            table.resize(i + 1, None);
        }
        table[i] = Some(name.into());
    }
}

/// A decided action as stored: ids, value and outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub seq: u64,
    pub action: Action,
    pub decision_code: u8,
}

fn encode_decision(seq: u64, a: &Action, decision: Decision) -> [u8; DECISION_BODY] {
    let mut b = [0u8; DECISION_BODY];
    b[0..8].copy_from_slice(&seq.to_le_bytes());
    b[8..16].copy_from_slice(&a.at.to_le_bytes());
    b[16..24].copy_from_slice(&a.usd_cents.to_le_bytes());
    b[24..28].copy_from_slice(&a.principal.0.to_le_bytes());
    b[28..32].copy_from_slice(&a.device.0.to_le_bytes());
    b[32..36].copy_from_slice(&a.resource.0.to_le_bytes());
    b[36..40].copy_from_slice(&a.destination.map_or(NONE, |d| d.0).to_le_bytes());
    b[40..44].copy_from_slice(&a.grant.map_or(NONE, |g| g.0).to_le_bytes());
    b[44] = a.kind as u8;
    b[45] = decision.code();
    b
}

fn decode_decision(b: &[u8; DECISION_BODY]) -> Option<Entry> {
    let u64_at = |i: usize| u64::from_le_bytes(b[i..i + 8].try_into().unwrap());
    let u32_at = |i: usize| u32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    let opt = |v: u32| (v != NONE).then_some(v);
    Some(Entry {
        seq: u64_at(0),
        action: Action {
            at: u64_at(8),
            usd_cents: u64_at(16),
            principal: PrincipalId(u32_at(24)),
            device: DeviceId(u32_at(28)),
            resource: ResourceId(u32_at(32)),
            destination: opt(u32_at(36)).map(DestinationId),
            grant: opt(u32_at(40)).map(GrantId),
            kind: *Kind::ALL.get(b[44] as usize)?,
        },
        decision_code: b[45],
    })
}

/// The previous hash is the BLAKE3 key, so a 49-byte decision frame is a single compression
/// (hashing `prev ‖ frame` would be 81 bytes, two compressions). Same chaining property: the
/// output depends on every earlier frame through the key.
#[inline]
fn chain(prev: &[u8; 32], frame: &[u8]) -> [u8; 32] {
    *blake3::keyed_hash(prev, frame).as_bytes()
}

/// Appends to a ledger file. Single writer.
pub struct Ledger {
    out: BufWriter<File>,
    key: SigningKey,
    head: [u8; 32],
    next_seq: u64,
    /// Frames appended so far, of every type: the unit durability is tracked in.
    frames: u64,
    /// The name each id is currently bound to, rebuilt from the file on open.
    names: NameTables,
    /// Set by the first failed write. The head has already moved past a frame that may not be on
    /// disk, so every later append would extend a chain the file doesn't have.
    failure: Option<String>,
    /// Bytes of a torn final frame dropped on open.
    recovered: u64,
    scratch: Vec<u8>,
}

impl Ledger {
    /// Opens or creates a ledger. An existing file is fully verified first; appending to a
    /// broken chain would launder the break.
    pub fn open(path: &Path, key: SigningKey) -> io::Result<Self> {
        Self::open_with(path, key, |_| {})
    }

    /// Like [`Ledger::open`], handing every name, decision and event to `visit` on the way, so
    /// the caller can rebuild its state from the same pass that verifies the chain.
    ///
    /// A crash in the middle of an append leaves a torn final frame. That one frame was never
    /// synced, so nothing was acted on because of it: it is cut off (see [`Ledger::recovered`])
    /// and the ledger opens. Any other break is refused.
    pub fn open_with(path: &Path, key: SigningKey, visit: impl FnMut(Item<'_>)) -> io::Result<Self> {
        let mut recovered = 0;
        let report = if path.exists() {
            let report = read(path, &key.verifying_key(), visit)?;
            if let Some(problem) = &report.problem {
                let len = std::fs::metadata(path)?.len();
                match report.torn_at {
                    Some(at) if len - at < MAX_FRAME => {
                        let file = OpenOptions::new().write(true).open(path)?;
                        file.set_len(at)?;
                        file.sync_all()?;
                        recovered = len - at;
                    }
                    _ => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("ledger is broken: {problem}"))),
                }
            }
            report
        } else {
            Report { head: GENESIS, ..Default::default() }
        };
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            out: BufWriter::with_capacity(1 << 16, file),
            key,
            head: report.head,
            next_seq: report.decisions,
            frames: report.frames,
            names: report.names,
            failure: None,
            recovered,
            scratch: Vec::with_capacity(512),
        })
    }

    /// Bytes of a torn final frame cut off when the ledger was opened (0 when it was clean).
    pub fn recovered(&self) -> u64 {
        self.recovered
    }

    /// Why the ledger stopped taking appends, if it has.
    pub fn failure(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    /// Frames appended so far (decisions, names, events and checkpoints).
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// The name `id` is currently bound to.
    pub fn name_of(&self, ns: Namespace, id: u32) -> Option<&str> {
        self.names[ns as usize].get(id as usize)?.as_deref()
    }

    fn usable(&self) -> io::Result<()> {
        match &self.failure {
            None => Ok(()),
            Some(why) => Err(io::Error::other(format!("ledger stopped after a failed write: {why}"))),
        }
    }

    fn fail<T>(&mut self, r: io::Result<T>) -> io::Result<T> {
        if let Err(e) = &r {
            self.failure.get_or_insert_with(|| e.to_string());
        }
        r
    }

    pub fn head(&self) -> [u8; 32] {
        self.head
    }

    pub fn len(&self) -> u64 {
        self.next_seq
    }

    pub fn is_empty(&self) -> bool {
        self.next_seq == 0
    }

    fn frame(&mut self, tag: u8, body: &[u8]) -> io::Result<()> {
        self.usable()?;
        self.scratch.clear();
        self.scratch.push(tag);
        self.scratch.extend_from_slice(body);
        self.head = chain(&self.head, &self.scratch);
        let written = self.out.write_all(&self.scratch).and_then(|()| self.out.write_all(&self.head));
        self.fail(written)?;
        self.frames += 1;
        Ok(())
    }

    /// Records what an id stands for: the first time it is used, and again whenever it now stands
    /// for something else (ids are handed out per process, so a restart can rebind them).
    pub fn name(&mut self, ns: Namespace, id: u32, name: &str) -> io::Result<()> {
        if self.name_of(ns, id) == Some(name) {
            return Ok(());
        }
        let n = name.as_bytes();
        let len = u16::try_from(n.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name too long"))?;
        let mut body = Vec::with_capacity(NAME_HEAD + n.len());
        body.push(ns as u8);
        body.extend_from_slice(&id.to_le_bytes());
        body.extend_from_slice(&len.to_le_bytes());
        body.extend_from_slice(n);
        self.frame(TAG_NAME, &body)?;
        bind(&mut self.names, ns as usize, id, name);
        Ok(())
    }

    /// Appends a state change. Write it before applying it, and wait for it to be durable before
    /// telling anyone it happened.
    pub fn event(&mut self, event: &Event) -> io::Result<()> {
        self.frame(TAG_EVENT, &encode_event(event))
    }

    /// Appends a decision; returns its sequence number. Buffered: call [`Ledger::sync`] to make
    /// it durable.
    #[inline]
    pub fn record(&mut self, action: &Action, decision: Decision) -> io::Result<u64> {
        let seq = self.next_seq;
        let body = encode_decision(seq, action, decision);
        self.frame(TAG_DECISION, &body)?;
        self.next_seq += 1;
        Ok(seq)
    }

    /// Signs the current head. Anyone with the public key can check the chain up to here.
    pub fn checkpoint(&mut self) -> io::Result<()> {
        let mut msg = [0u8; 40];
        msg[..8].copy_from_slice(&self.next_seq.to_le_bytes());
        msg[8..].copy_from_slice(&self.head);
        let sig = self.key.sign(&msg).to_bytes();
        let mut body = [0u8; CHECKPOINT_BODY];
        body[..8].copy_from_slice(&self.next_seq.to_le_bytes());
        body[8..].copy_from_slice(&sig);
        self.frame(TAG_CHECKPOINT, &body)
    }

    /// Flushes and fsyncs. Batch many records per sync (group commit) for throughput.
    pub fn sync(&mut self) -> io::Result<()> {
        self.usable()?;
        let synced = self.out.flush().and_then(|()| self.out.get_ref().sync_data());
        self.fail(synced)
    }

    /// Hands buffered frames to the OS without waiting for the disk. Pair with
    /// [`Ledger::file`] to fsync outside whatever lock guards the ledger.
    pub fn flush(&mut self) -> io::Result<()> {
        self.usable()?;
        let flushed = self.out.flush();
        self.fail(flushed)
    }

    /// A second handle to the ledger file, for fsyncing from another thread.
    pub fn file(&self) -> io::Result<File> {
        self.out.get_ref().try_clone()
    }
}

/// What [`verify`] found.
#[derive(Debug, Default)]
pub struct Report {
    pub decisions: u64,
    pub checkpoints: u64,
    /// Decisions covered by the last valid checkpoint.
    pub signed_through: u64,
    pub head: [u8; 32],
    /// Complete, verified frames of every type.
    pub frames: u64,
    /// First problem found; `None` means the whole file is intact.
    pub problem: Option<String>,
    /// When the problem is a final frame cut short: the byte offset where that frame starts,
    /// which is also where the intact part of the file ends.
    pub torn_at: Option<u64>,
    names: NameTables,
}

impl Report {
    pub fn intact(&self) -> bool {
        self.problem.is_none()
    }
}

/// Reads a ledger, calling `visit` for every decision and name in order. Stops at the first break.
pub fn read(path: &Path, key: &VerifyingKey, mut visit: impl FnMut(Item<'_>)) -> io::Result<Report> {
    let mut r = BufReader::with_capacity(1 << 16, File::open(path)?);
    let mut rep = Report { head: GENESIS, ..Default::default() };
    let mut frame = Vec::with_capacity(512);
    let mut hash = [0u8; 32];
    // Byte offset of the end of the last complete frame.
    let mut offset = 0u64;
    // `Ok(false)` when the file ends inside the read.
    let fill = |r: &mut BufReader<File>, buf: &mut [u8]| match r.read_exact(buf) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e),
    };
    loop {
        let mut tag = [0u8; 1];
        if !fill(&mut r, &mut tag)? {
            break;
        }
        frame.clear();
        frame.push(tag[0]);
        let body_len = match tag[0] {
            TAG_DECISION => DECISION_BODY,
            TAG_CHECKPOINT => CHECKPOINT_BODY,
            TAG_EVENT => EVENT_BODY,
            TAG_NAME => {
                let mut head = [0u8; NAME_HEAD];
                if !fill(&mut r, &mut head)? {
                    rep.problem = Some(format!("truncated name frame after decision {}", rep.decisions));
                    rep.torn_at = Some(offset);
                    break;
                }
                frame.extend_from_slice(&head);
                u16::from_le_bytes([head[5], head[6]]) as usize
            }
            t => {
                rep.problem = Some(format!("unknown frame type {t} after decision {}", rep.decisions));
                break;
            }
        };
        let start = frame.len();
        frame.resize(start + body_len, 0);
        if !fill(&mut r, &mut frame[start..])? || !fill(&mut r, &mut hash)? {
            rep.problem = Some(format!("truncated frame after decision {}", rep.decisions));
            rep.torn_at = Some(offset);
            break;
        }
        let expect = chain(&rep.head, &frame);
        if expect != hash {
            rep.problem = Some(format!("hash chain breaks after decision {}: a frame was altered, removed or reordered", rep.decisions));
            break;
        }
        // Checkpoints sign the head as it was before their own frame was chained.
        let prev = std::mem::replace(&mut rep.head, hash);
        offset += (frame.len() + HASH) as u64;
        rep.frames += 1;
        match frame[0] {
            TAG_DECISION => {
                let body: &[u8; DECISION_BODY] = frame[1..].try_into().unwrap();
                let Some(entry) = decode_decision(body) else {
                    rep.problem = Some(format!("decision {} is malformed", rep.decisions));
                    break;
                };
                if entry.seq != rep.decisions {
                    rep.problem = Some(format!("decision {} has sequence {}", rep.decisions, entry.seq));
                    break;
                }
                rep.decisions += 1;
                visit(Item::Decision(entry));
            }
            TAG_CHECKPOINT => {
                let seq = u64::from_le_bytes(frame[1..9].try_into().unwrap());
                let sig = Signature::from_bytes(frame[9..73].try_into().unwrap());
                let mut msg = [0u8; 40];
                msg[..8].copy_from_slice(&seq.to_le_bytes());
                msg[8..].copy_from_slice(&prev);
                if seq != rep.decisions || key.verify_strict(&msg, &sig).is_err() {
                    rep.problem = Some(format!("checkpoint after decision {} has a bad signature", rep.decisions));
                    break;
                }
                rep.checkpoints += 1;
                rep.signed_through = seq;
            }
            TAG_EVENT => {
                let body: &[u8; EVENT_BODY] = frame[1..].try_into().unwrap();
                let Some(event) = decode_event(body) else {
                    rep.problem = Some(format!("event after decision {} is malformed", rep.decisions));
                    break;
                };
                visit(Item::Event(event));
            }
            _ => {
                let ns = frame[1];
                let id = u32::from_le_bytes(frame[2..6].try_into().unwrap());
                let Ok(name) = std::str::from_utf8(&frame[8..]) else {
                    rep.problem = Some("a name is not UTF-8".into());
                    break;
                };
                bind(&mut rep.names, ns as usize, id, name);
                visit(Item::Name { namespace: ns, id, name });
            }
        }
    }
    Ok(rep)
}

/// One item in a ledger, in order.
#[derive(Debug)]
pub enum Item<'a> {
    Name { namespace: u8, id: u32, name: &'a str },
    Decision(Entry),
    Event(Event),
}

/// Verifies a whole ledger file.
pub fn verify(path: &Path, key: &VerifyingKey) -> io::Result<Report> {
    read(path, key, |_| {})
}

/// A fresh random signing key.
pub fn generate_key() -> SigningKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).expect("OS randomness");
    SigningKey::from_bytes(&seed)
}

#[cfg(test)]
mod tests;
