//! Tamper-evident decision ledger.
//!
//! Every frame is chained: `hash = BLAKE3-keyed(key = previous hash, frame)`. Changing, removing or
//! reordering any frame breaks every hash after it. Checkpoints sign `(seq, hash)` with Ed25519,
//! so a verifier holding only the public key can tell the chain is the one the gateway wrote,
//! not a rebuilt forgery.
//!
//! The file is self-describing: the first time an id appears, a name frame records what it
//! stands for, inside the chain. Evidence exported from it reads without any other database.
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
const DECISION_BODY: usize = 48;
const CHECKPOINT_BODY: usize = 8 + 64;
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
    /// Which ids already have a name frame, per namespace (bitsets).
    named: [Vec<u64>; 4],
    scratch: Vec<u8>,
}

impl Ledger {
    /// Opens or creates a ledger. An existing file is fully verified first; appending to a
    /// broken chain would launder the break.
    pub fn open(path: &Path, key: SigningKey) -> io::Result<Self> {
        let (head, next_seq, named) = if path.exists() {
            let report = verify(path, &key.verifying_key())?;
            if let Some(problem) = report.problem {
                return Err(io::Error::new(io::ErrorKind::InvalidData, format!("ledger is broken: {problem}")));
            }
            (report.head, report.decisions, report.named)
        } else {
            (GENESIS, 0, Default::default())
        };
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self { out: BufWriter::with_capacity(1 << 16, file), key, head, next_seq, named, scratch: Vec::with_capacity(512) })
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
        self.scratch.clear();
        self.scratch.push(tag);
        self.scratch.extend_from_slice(body);
        self.head = chain(&self.head, &self.scratch);
        self.out.write_all(&self.scratch)?;
        self.out.write_all(&self.head)
    }

    /// Records a name the first time an id is used, so the ledger explains itself.
    pub fn name(&mut self, ns: Namespace, id: u32, name: &str) -> io::Result<()> {
        let bits = &mut self.named[ns as usize];
        let (w, b) = (id as usize / 64, id % 64);
        if bits.len() <= w {
            bits.resize(w + 1, 0);
        }
        if bits[w] & (1 << b) != 0 {
            return Ok(());
        }
        bits[w] |= 1 << b;
        let n = name.as_bytes();
        let len = u16::try_from(n.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "name too long"))?;
        let mut body = Vec::with_capacity(7 + n.len());
        body.push(ns as u8);
        body.extend_from_slice(&id.to_le_bytes());
        body.extend_from_slice(&len.to_le_bytes());
        body.extend_from_slice(n);
        self.frame(TAG_NAME, &body)
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
        self.out.flush()?;
        self.out.get_ref().sync_data()
    }

    /// Hands buffered frames to the OS without waiting for the disk. Pair with
    /// [`Ledger::file`] to fsync outside whatever lock guards the ledger.
    pub fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
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
    /// First problem found; `None` means the whole file is intact.
    pub problem: Option<String>,
    named: [Vec<u64>; 4],
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
    loop {
        let mut tag = [0u8; 1];
        match r.read_exact(&mut tag) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        }
        frame.clear();
        frame.push(tag[0]);
        let body_len = match tag[0] {
            TAG_DECISION => DECISION_BODY,
            TAG_CHECKPOINT => CHECKPOINT_BODY,
            TAG_NAME => {
                let mut head = [0u8; 7];
                if r.read_exact(&mut head).is_err() {
                    rep.problem = Some(format!("truncated name frame after decision {}", rep.decisions));
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
        if r.read_exact(&mut frame[start..]).is_err() || r.read_exact(&mut hash).is_err() {
            rep.problem = Some(format!("truncated frame after decision {}", rep.decisions));
            break;
        }
        let expect = chain(&rep.head, &frame);
        if expect != hash {
            rep.problem = Some(format!("hash chain breaks after decision {}: a frame was altered, removed or reordered", rep.decisions));
            break;
        }
        // Checkpoints sign the head as it was before their own frame was chained.
        let prev = std::mem::replace(&mut rep.head, hash);
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
            _ => {
                let ns = frame[1];
                let id = u32::from_le_bytes(frame[2..6].try_into().unwrap());
                let Ok(name) = std::str::from_utf8(&frame[8..]) else {
                    rep.problem = Some("a name is not UTF-8".into());
                    break;
                };
                if let Some(bits) = rep.named.get_mut(ns as usize) {
                    let w = id as usize / 64;
                    if bits.len() <= w {
                        bits.resize(w + 1, 0);
                    }
                    bits[w] |= 1 << (id % 64);
                }
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
