import { createHash } from "node:crypto";
import path from "node:path";
import { AAD, MESSAGE_IDS, PROTOCOL_VERSION, newChallenge, open, seal, verifyDecision, type KeyView, type RequestView, type SignedDecision, type Snapshot, type UnpairNotice } from "@sikrets/pairing";
import { approvals, decide, isOpen, reasonText, type ApprovalRequest, type Rotate } from "./approvals.ts";
import { readJson } from "./fs.ts";
import { withLock, writeAtomic } from "./lock.ts";
import { ensureGitignore } from "./files.ts";
import { projectName, state, type Resource } from "./state.ts";
import { forgetPairing, type Link } from "./pairing.ts";
import { PROJECT_DIR, RELAY } from "../constants.ts";

// The Doorman, reached through a paired phone. `push` seals this project's open requests and key
// inventory (names and status, never values) for the phone. `poll` reads the phone's signed answers,
// checks each signature against the paired phone's key and a one-time challenge this laptop issued,
// and only then decides, running the rotation on approval. The relay can drop or delay messages;
// it can't approve anything.

/**
 * The one-time challenge for a request shown on the phone. "issued": the phone may sign it.
 * "used": a signed answer consumed it; kept as a tombstone so a replay, or a stale writer, can't
 * bring it back. A request that reopens (a failed rotation) gets a new issued challenge.
 */
type Challenge = { status: "issued"; challenge: string; expiresAt: string } | { status: "used"; challenge: string; usedAt: string };

interface ProjectRelayState {
  seq: number;
  /** requestId → its current challenge. */
  challenges: Record<string, Challenge>;
}

const stateFile = (root: string) => path.join(root, PROJECT_DIR, RELAY.projectFile);

async function loadState(root: string): Promise<ProjectRelayState> {
  const s = await readJson<ProjectRelayState>(stateFile(root), { seq: 0, challenges: {} });
  // Files from before tombstones held only issued challenges, without a status.
  for (const [id, c] of Object.entries(s.challenges)) if (!c.status) s.challenges[id] = { ...(c as { challenge: string; expiresAt: string }), status: "issued" };
  return s;
}

/** Load, change and save relay.json under its lock, so push and poll never undo each other. */
async function updateState<T>(root: string, fn: (s: ProjectRelayState) => T): Promise<T> {
  await ensureGitignore(root, [`${PROJECT_DIR}/${RELAY.projectFile}`]);
  return withLock(stateFile(root), async () => {
    const s = await loadState(root);
    const out = fn(s);
    await writeAtomic(stateFile(root), JSON.stringify(s, null, 2) + "\n");
    return out;
  });
}

/** One snapshot per project, so several projects can share a phone. */
export const snapshotId = (root: string) => RELAY.snapshotIdPrefix + createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);

export function keyView(r: Resource, now = Date.now()): KeyView {
  const status: KeyView["status"] = !r.applied ? "not applied" : r.rotateBy && Date.parse(r.rotateBy) <= now ? "rotation due" : "active";
  return { name: r.name, provider: r.provider, recipe: r.recipe, status, rotateBy: r.rotateBy, lastRotatedAt: r.lastRotatedAt };
}

/** Seals and uploads this project's open requests and key inventory. */
export async function push(root: string, link: Link, now = new Date()): Promise<Snapshot> {
  const all = await approvals.load(root, now);
  const open = all.filter(isOpen);
  const { seq, challenges } = await updateState(root, (s) => {
    const next: ProjectRelayState["challenges"] = {};
    for (const r of all) {
      const c = s.challenges[r.id];
      // Keep a request's challenge while it stays open, so a decision already signed on the phone still verifies.
      if (isOpen(r) && (!c || c.status === "issued")) next[r.id] = c ?? { status: "issued", challenge: newChallenge(), expiresAt: r.expiresAt };
      // A used one is replaced only once the request has reopened (a failed rotation) or the answer
      // never landed; right after use, the decision is still being applied.
      else if (isOpen(r) && c!.status === "used" && (r.status === "failed" || now.getTime() - Date.parse(c!.usedAt) > RELAY.reissueAfterMs)) next[r.id] = { status: "issued", challenge: newChallenge(), expiresAt: r.expiresAt };
      else if (c?.status === "used") next[r.id] = c;
    }
    s.seq += 1;
    s.challenges = next;
    return { seq: s.seq, challenges: next };
  });
  const recent = all.filter((r) => !isOpen(r) && now.getTime() - Date.parse(r.decidedAt ?? r.createdAt) < RELAY.recentMs);
  const challengeFor = (r: ApprovalRequest) => {
    const c = challenges[r.id];
    return isOpen(r) && c?.status === "issued" ? c.challenge : "";
  };
  const view = (r: ApprovalRequest): RequestView => ({
    id: r.id,
    resource: r.resource,
    reason: r.reason,
    message: reasonText(r.reason),
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    challenge: challengeFor(r),
  });
  const snapshot: Snapshot = {
    v: PROTOCOL_VERSION,
    seq,
    sentAt: now.toISOString(),
    project: projectName(root),
    requests: [...open, ...recent].map(view),
    keys: (await state.load(root)).resources.map((r) => keyView(r, now.getTime())),
  };
  await link.relay.put(link.pairing.toPhone, snapshotId(root), seal(link.key, AAD.toPhone, snapshot), RELAY.snapshotTtlSeconds);
  return snapshot;
}

export type Outcome = { requestId: string; result: ApprovalRequest["status"] } | { requestId: string; rejected: string };

/**
 * Reads the phone's answers once. Each valid one consumes its challenge (under the relay.json lock,
 * checked and marked used in one step) before anything is decided, so the same signed message can
 * never act twice. Answers for requests in other projects are left for those projects' CLIs.
 */
export async function poll(root: string, link: Link, rotate: Rotate, now = () => Date.now()): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const messages = (await link.relay.list(link.pairing.toCli)).filter((m) => m.id !== MESSAGE_IDS.hello);
  for (const m of messages) {
    if (m.id === MESSAGE_IDS.unpaired) {
      if (await unpairedByPhone(link, m.blob)) throw new PhoneUnpairedError(link.pairing.phoneName);
      await link.relay.remove(link.pairing.toCli, m.id);
      continue;
    }
    let d: SignedDecision;
    try {
      d = open<SignedDecision>(link.key, AAD.toCli, m.blob);
    } catch {
      await link.relay.remove(link.pairing.toCli, m.id); // not from our phone
      continue;
    }
    const mine = (await approvals.load(root)).find((r) => r.id === d.requestId);
    if (!mine) continue; // another project's request
    const verdict = await updateState(root, (s) => {
      const issued = s.challenges[d.requestId];
      if (issued?.status !== "issued") return { ok: false, why: "stale or reused challenge" } as const;
      const v = verifyDecision(link.pairing.phoneSignKey, d, { pairingId: link.pairing.pairingId, requestId: mine.id, resource: mine.resource, challenge: issued.challenge, expiresAt: mine.expiresAt }, now());
      if (v.ok) s.challenges[d.requestId] = { status: "used", challenge: issued.challenge, usedAt: new Date(now()).toISOString() };
      return v;
    });
    await link.relay.remove(link.pairing.toCli, m.id);
    if (!verdict.ok) {
      outcomes.push({ requestId: d.requestId, rejected: verdict.why });
      continue;
    }
    try {
      const out = await decide(root, mine, async () => ({ decision: verdict.decision, by: "phone" }), rotate);
      outcomes.push({ requestId: out.id, result: out.status });
    } catch (error) {
      // Report where the request really is: a failed rotation, or one decided elsewhere meanwhile.
      const stored = (await approvals.load(root)).find((r) => r.id === mine.id);
      if (stored?.status === "failed") outcomes.push({ requestId: mine.id, result: "failed" });
      else outcomes.push({ requestId: mine.id, rejected: stored && stored.status !== "pending" ? `already ${stored.status}` : error instanceof Error ? error.message : "not applied" });
    }
  }
  return outcomes;
}

/** The phone said it unpaired. Thrown out of `poll` once the local pairing has been removed too. */
export class PhoneUnpairedError extends Error {
  constructor(phone: string) {
    super(`${phone} unpaired from this laptop. Pair again with: sikrets pair`);
  }
}

/** An unpair notice sealed with this pairing's key: forget the pairing here as well. */
async function unpairedByPhone(link: Link, blob: string): Promise<boolean> {
  try {
    const notice = open<UnpairNotice>(link.key, AAD.toCli, blob);
    if (notice.pairingId !== link.pairing.pairingId) return false;
  } catch {
    return false;
  }
  await forgetPairing({ notify: false });
  return true;
}
