import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureGitignore } from "./files.ts";
import { readJson } from "./fs.ts";
import { alive, withLock, writeAtomic } from "./lock.ts";
import { after } from "./ttl.ts";
import { APPROVAL_REASONS, APPROVAL_ROTATING_MAX_MS, APPROVAL_TTL, APPROVALS_FILE, PROJECT_DIR } from "../constants.ts";

// The Doorman: on the free tier nothing rotates a key on its own. A trigger (possible exposure, an
// overdue key, an agent asking) files a pending request, and a person approves or denies it.
// Requests store a generic reason category only, never where a detection came from, so nothing
// shown to a person, written to disk or sent to a phone can name the source.
//
//   pending ──approve──▶ rotating ──rotated──▶ rotated
//      │  ▲                 └──fail / crashed──▶ failed ──approve──▶ rotating (retry)
//      │  └──────────────────────────────────────┤
//      ├──deny───▶ denied ◀──────deny────────────┤
//      └──expire─▶ expired ◀─────expire──────────┘
//
// Every move goes through `applyEvent`, which reloads the file under a lock and applies the event to
// the record as it is now, so a decision made on a stale copy (a long Touch ID prompt, a second
// window, a phone answer) can never overwrite a newer one.

export type Reason = keyof typeof APPROVAL_REASONS;
export type Status = "pending" | "rotating" | "rotated" | "denied" | "expired" | "failed";
export type Event = "approve" | "deny" | "expire" | "rotated" | "fail";
/** How the person said yes or no. "cli" is a deny or a terminal confirm, never a silent approve. */
export type DecidedBy = "touchid" | "dialog" | "terminal" | "cli" | "phone";

export interface ApprovalRequest {
  id: string;
  resource: string;
  reason: Reason;
  status: Status;
  createdAt: string;
  /** When a pending or failed request lapses. A failure resets it so there is time to retry. */
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: DecidedBy;
  /** While rotating: which process runs the rotation and since when, so a crash can be detected. */
  rotation?: { pid: number; startedAt: string };
  rotatedAt?: string;
  /** Why the last rotation failed. */
  error?: string;
}

const NEXT: Record<Status, Partial<Record<Event, Status>>> = {
  pending: { approve: "rotating", deny: "denied", expire: "expired" },
  rotating: { rotated: "rotated", fail: "failed" },
  failed: { approve: "rotating", deny: "denied", expire: "expired" },
  denied: {},
  expired: {},
  rotated: {},
};
const PAST: Record<Event, string> = { approve: "approved", deny: "denied", expire: "expired", rotated: "marked rotated", fail: "marked failed" };

export const isReason = (r: unknown): r is Reason => typeof r === "string" && r in APPROVAL_REASONS;
export const reasonText = (r: Reason) => APPROVAL_REASONS[r];
/** Waiting for a person: pending, or a failed rotation that can be retried or denied. */
export const isOpen = (r: ApprovalRequest) => r.status === "pending" || r.status === "failed";
/** Not finished yet: open, or a rotation in flight. One of these per resource at most. */
export const isActive = (r: ApprovalRequest) => isOpen(r) || r.status === "rotating";

type Opts = { by?: DecidedBy; now?: Date; error?: string };

/** Pure: the request after an event, or an error naming why that move isn't allowed. */
export function transition(req: ApprovalRequest, event: Event, opts: Opts = {}): ApprovalRequest {
  const to = NEXT[req.status][event];
  if (!to) throw new Error(`Request ${req.id} is ${req.status}; it can't be ${PAST[event]}`);
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const { rotation: _, error: __, ...rest } = req;
  switch (event) {
    case "approve":
      return { ...rest, status: to, decidedAt: at, decidedBy: opts.by, rotation: { pid: process.pid, startedAt: at } };
    case "deny":
      return { ...rest, status: to, decidedAt: at, decidedBy: opts.by };
    case "rotated":
      return { ...rest, status: to, rotatedAt: at };
    case "fail":
      return { ...rest, status: to, error: opts.error ?? "rotation failed", expiresAt: after(APPROVAL_TTL, now.getTime()) };
    case "expire":
      return { ...rest, status: to };
  }
}

/** Moves the clock can make on its own: lapse an open request, or fail a rotation whose process died. */
export function settle(r: ApprovalRequest, now = new Date()): ApprovalRequest {
  if (isOpen(r) && Date.parse(r.expiresAt) <= now.getTime()) return transition(r, "expire", { now });
  if (r.status === "rotating") {
    const since = Date.parse(r.rotation?.startedAt ?? r.decidedAt ?? r.createdAt);
    const gone = !r.rotation || (r.rotation.pid !== process.pid && !alive(r.rotation.pid));
    if (gone || now.getTime() - since > APPROVAL_ROTATING_MAX_MS) return transition(r, "fail", { now, error: "the rotation was interrupted; check the key, then approve again or deny" });
  }
  return r;
}

/** Files written before "rotating" existed called it "approved". */
const upgrade = (r: ApprovalRequest): ApprovalRequest => ((r.status as string) === "approved" ? { ...r, status: "rotating" } : r);

const file = (root: string) => path.join(root, PROJECT_DIR, APPROVALS_FILE);

async function read(root: string, now: Date) {
  return (await readJson<ApprovalRequest[]>(file(root), [])).map((r) => settle(upgrade(r), now));
}

/** Read, change and write the whole file under the lock. */
async function mutate<T>(root: string, now: Date, fn: (all: ApprovalRequest[]) => { all: ApprovalRequest[]; out: T }): Promise<T> {
  await ensureGitignore(root, [`${PROJECT_DIR}/${APPROVALS_FILE}`]);
  return withLock(file(root), async () => {
    const { all, out } = fn(await read(root, now));
    await writeAtomic(file(root), JSON.stringify(all, null, 2) + "\n");
    return out;
  });
}

export const approvals = {
  /** Loads requests as they stand now: lapsed ones show as expired, crashed rotations as failed. */
  load: (root: string, now = new Date()) => read(root, now),
  async find(root: string, id: string) {
    const req = (await approvals.load(root)).find((r) => r.id === id);
    if (!req) throw new Error(`No approval request ${id}. See: sikrets approvals`);
    return req;
  },
};

/**
 * The only way to change a stored request. Applies `event` to the current record under the lock and
 * throws if that move isn't allowed from where the request is now.
 */
export async function applyEvent(root: string, id: string, event: Event, opts: Opts = {}): Promise<ApprovalRequest> {
  const now = opts.now ?? new Date();
  return mutate(root, now, (all) => {
    const i = all.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`No approval request ${id}. See: sikrets approvals`);
    const next = transition(all[i]!, event, { ...opts, now });
    return { all: all.with(i, next), out: next };
  });
}

/** Files a pending request, or returns the one already active for that resource so triggers don't pile up. */
export async function requestRotation(root: string, resource: string, reason: Reason, now = new Date()): Promise<{ request: ApprovalRequest; created: boolean }> {
  return mutate<{ request: ApprovalRequest; created: boolean }>(root, now, (all) => {
    const active = all.find((r) => r.resource === resource && isActive(r));
    if (active) return { all, out: { request: active, created: false } };
    const request: ApprovalRequest = {
      id: `apr_${randomBytes(4).toString("hex")}`,
      resource,
      reason,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: after(APPROVAL_TTL, now.getTime()),
    };
    return { all: all.concat(request), out: { request, created: true } };
  });
}

/** What the person decided when asked. "dismissed" leaves the request pending. */
export type Answer = { decision: "approve" | "deny"; by: DecidedBy } | { decision: "dismissed" };
export type Approver = (req: ApprovalRequest) => Promise<Answer>;
export type Rotate = (resource: string) => Promise<void>;

/**
 * Asks a person, records the answer, and on approval runs the rotation. The answer is applied to the
 * request as stored when it arrives, not as it was when the prompt opened: if it was denied, expired
 * or approved elsewhere meanwhile, this throws and nothing rotates. A rotation failure is recorded
 * on the request (status "failed", retryable) and rethrown.
 */
export async function decide(root: string, req: ApprovalRequest, ask: Approver, rotate: Rotate): Promise<ApprovalRequest> {
  const fresh = await approvals.find(root, req.id);
  if (!isOpen(fresh)) throw new Error(`Request ${req.id} is ${fresh.status}; nothing to decide`);
  const answer = await ask(fresh);
  if (answer.decision === "dismissed") return fresh;
  const current = await applyEvent(root, req.id, answer.decision, { by: answer.by });
  if (current.status !== "rotating") return current;
  try {
    await rotate(current.resource);
  } catch (error) {
    await applyEvent(root, req.id, "fail"); // the provider's message is shown, not stored: it may quote a response
    throw error;
  }
  return applyEvent(root, req.id, "rotated");
}
