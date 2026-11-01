import { createHash } from "node:crypto";
import path from "node:path";
import { AAD, MESSAGE_IDS, PROTOCOL_VERSION, newChallenge, open, seal, verifyDecision, type KeyView, type RequestView, type SignedDecision, type Snapshot } from "@sikrets/pairing";
import { approvals, decide, isOpen, reasonText, type ApprovalRequest, type Rotate } from "./approvals.ts";
import { readJson, writeJson } from "./fs.ts";
import { ensureGitignore } from "./files.ts";
import { projectName, state, type Resource } from "./state.ts";
import type { Link } from "./pairing.ts";
import { PROJECT_DIR, RELAY } from "../constants.ts";

// The Doorman, reached through a paired phone. `push` seals this project's open requests and key
// inventory (names and status, never values) for the phone. `poll` reads the phone's signed answers,
// checks each signature against the paired phone's key and a one-time challenge this laptop issued,
// and only then decides, running the rotation on approval. The relay can drop or delay messages;
// it can't approve anything.

interface ProjectRelayState {
  seq: number;
  /** requestId → the challenge the phone must sign. Removed on first use. */
  challenges: Record<string, { challenge: string; expiresAt: string }>;
}

const stateFile = (root: string) => path.join(root, PROJECT_DIR, RELAY.projectFile);
const loadState = (root: string) => readJson<ProjectRelayState>(stateFile(root), { seq: 0, challenges: {} });
async function saveState(root: string, s: ProjectRelayState) {
  await ensureGitignore(root, [`${PROJECT_DIR}/${RELAY.projectFile}`]);
  await writeJson(stateFile(root), s);
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
  const s = await loadState(root);
  const open = all.filter(isOpen);
  // Keep a request's challenge while it stays open, so a decision already signed on the phone still verifies.
  const challenges: ProjectRelayState["challenges"] = {};
  for (const r of open) challenges[r.id] = s.challenges[r.id] ?? { challenge: newChallenge(), expiresAt: r.expiresAt };
  const recent = all.filter((r) => !isOpen(r) && now.getTime() - Date.parse(r.decidedAt ?? r.createdAt) < RELAY.recentMs);
  const view = (r: ApprovalRequest): RequestView => ({
    id: r.id,
    resource: r.resource,
    reason: r.reason,
    message: reasonText(r.reason),
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    challenge: challenges[r.id]?.challenge ?? "",
  });
  const snapshot: Snapshot = {
    v: PROTOCOL_VERSION,
    seq: s.seq + 1,
    sentAt: now.toISOString(),
    project: projectName(root),
    requests: [...open, ...recent].map(view),
    keys: (await state.load(root)).resources.map((r) => keyView(r, now.getTime())),
  };
  await saveState(root, { seq: snapshot.seq, challenges });
  await link.relay.put(link.pairing.toPhone, snapshotId(root), seal(link.key, AAD.toPhone, snapshot), RELAY.snapshotTtlSeconds);
  return snapshot;
}

export type Outcome = { requestId: string; result: ApprovalRequest["status"] } | { requestId: string; rejected: string };

/**
 * Reads the phone's answers once. Each valid one is applied and its challenge consumed before the
 * rotation runs, so the same signed message can never act twice. Answers for requests in other
 * projects are left for those projects' CLIs.
 */
export async function poll(root: string, link: Link, rotate: Rotate, now = () => Date.now()): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const messages = (await link.relay.list(link.pairing.toCli)).filter((m) => m.id !== MESSAGE_IDS.hello);
  for (const m of messages) {
    let d: SignedDecision;
    try {
      d = open<SignedDecision>(link.key, AAD.toCli, m.blob);
    } catch {
      await link.relay.remove(link.pairing.toCli, m.id); // not from our phone
      continue;
    }
    const mine = (await approvals.load(root)).find((r) => r.id === d.requestId);
    if (!mine) continue; // another project's request
    const s = await loadState(root);
    const issued = s.challenges[d.requestId];
    const verdict = issued
      ? verifyDecision(link.pairing.phoneSignKey, d, { pairingId: link.pairing.pairingId, requestId: mine.id, resource: mine.resource, challenge: issued.challenge, expiresAt: mine.expiresAt }, now())
      : ({ ok: false, why: "stale or reused challenge" } as const);
    await link.relay.remove(link.pairing.toCli, m.id);
    if (!verdict.ok) {
      outcomes.push({ requestId: d.requestId, rejected: verdict.why });
      continue;
    }
    delete s.challenges[d.requestId];
    await saveState(root, s);
    if (!isOpen(mine)) {
      outcomes.push({ requestId: mine.id, rejected: `already ${mine.status}` });
      continue;
    }
    try {
      const out = await decide(root, mine, async () => ({ decision: verdict.decision, by: "phone" }), rotate);
      outcomes.push({ requestId: out.id, result: out.status });
    } catch {
      outcomes.push({ requestId: mine.id, result: "failed" });
    }
  }
  return outcomes;
}
