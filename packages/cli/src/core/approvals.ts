import { randomBytes } from "node:crypto";
import path from "node:path";
import { ensureGitignore } from "./files.ts";
import { readJson, writeJson } from "./fs.ts";
import { after } from "./ttl.ts";
import { APPROVAL_REASONS, APPROVAL_TTL, APPROVALS_FILE, PROJECT_DIR } from "../constants.ts";

// The Doorman: on the free tier nothing rotates a key on its own. A trigger (possible exposure, an
// overdue key, an agent asking) files a pending request, and a person approves or denies it.
// Requests store a generic reason category only, never where a detection came from, so nothing
// shown to a person, written to disk or sent to a phone can name the source.
//
//   pending ──approve──▶ approved ──rotated──▶ rotated
//      │                    └──────fail──────▶ failed ──approve──▶ approved (retry)
//      ├──deny───▶ denied
//      └──expire─▶ expired

export type Reason = keyof typeof APPROVAL_REASONS;
export type Status = "pending" | "approved" | "denied" | "expired" | "rotated" | "failed";
export type Event = "approve" | "deny" | "expire" | "rotated" | "fail";
/** How the person said yes or no. "cli" is a deny or a terminal confirm, never a silent approve. */
export type DecidedBy = "touchid" | "dialog" | "terminal" | "cli";

export interface ApprovalRequest {
  id: string;
  resource: string;
  reason: Reason;
  status: Status;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: DecidedBy;
  rotatedAt?: string;
}

const NEXT: Record<Status, Partial<Record<Event, Status>>> = {
  pending: { approve: "approved", deny: "denied", expire: "expired" },
  approved: { rotated: "rotated", fail: "failed" },
  failed: { approve: "approved" },
  denied: {},
  expired: {},
  rotated: {},
};
const PAST: Record<Event, string> = { approve: "approved", deny: "denied", expire: "expired", rotated: "marked rotated", fail: "marked failed" };

export const isReason = (r: unknown): r is Reason => typeof r === "string" && r in APPROVAL_REASONS;
export const reasonText = (r: Reason) => APPROVAL_REASONS[r];
export const isOpen = (r: ApprovalRequest) => r.status === "pending" || r.status === "failed";

/** Pure: the request after an event, or an error naming why that move isn't allowed. */
export function transition(req: ApprovalRequest, event: Event, opts: { by?: DecidedBy; now?: Date } = {}): ApprovalRequest {
  const to = NEXT[req.status][event];
  if (!to) throw new Error(`Request ${req.id} is ${req.status}; it can't be ${PAST[event]}`);
  const at = (opts.now ?? new Date()).toISOString();
  if (event === "approve" || event === "deny") return { ...req, status: to, decidedAt: at, decidedBy: opts.by };
  if (event === "rotated") return { ...req, status: to, rotatedAt: at };
  return { ...req, status: to };
}

const file = (root: string) => path.join(root, PROJECT_DIR, APPROVALS_FILE);

export const approvals = {
  /** Loads requests, lapsing any pending one past its expiry. */
  async load(root: string, now = new Date()): Promise<ApprovalRequest[]> {
    const all = await readJson<ApprovalRequest[]>(file(root), []);
    return all.map((r) => (r.status === "pending" && Date.parse(r.expiresAt) <= now.getTime() ? transition(r, "expire", { now }) : r));
  },
  async save(root: string, all: ApprovalRequest[]) {
    await ensureGitignore(root, [`${PROJECT_DIR}/${APPROVALS_FILE}`]);
    await writeJson(file(root), all);
  },
  async update(root: string, req: ApprovalRequest) {
    const all = await approvals.load(root);
    await approvals.save(root, all.filter((r) => r.id !== req.id).concat(req));
    return req;
  },
  async find(root: string, id: string) {
    const req = (await approvals.load(root)).find((r) => r.id === id);
    if (!req) throw new Error(`No approval request ${id}. See: sikrets approvals`);
    return req;
  },
};

/** Files a pending request, or returns the one already open for that resource so triggers don't pile up. */
export async function requestRotation(root: string, resource: string, reason: Reason, now = new Date()): Promise<{ request: ApprovalRequest; created: boolean }> {
  const all = await approvals.load(root, now);
  const open = all.find((r) => r.resource === resource && r.status === "pending");
  if (open) return { request: open, created: false };
  const request: ApprovalRequest = {
    id: `apr_${randomBytes(4).toString("hex")}`,
    resource,
    reason,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: after(APPROVAL_TTL, now.getTime()),
  };
  await approvals.save(root, all.concat(request));
  return { request, created: true };
}

/** What the person decided when asked. "dismissed" leaves the request pending. */
export type Answer = { decision: "approve" | "deny"; by: DecidedBy } | { decision: "dismissed" };
export type Approver = (req: ApprovalRequest) => Promise<Answer>;
export type Rotate = (resource: string) => Promise<void>;

/**
 * Asks a person, records the answer, and on approval runs the rotation. A rotation failure is
 * recorded on the request (status "failed", retryable) and rethrown.
 */
export async function decide(root: string, req: ApprovalRequest, ask: Approver, rotate: Rotate): Promise<ApprovalRequest> {
  if (!isOpen(req)) throw new Error(`Request ${req.id} is ${req.status}; nothing to decide`);
  const answer = await ask(req);
  if (answer.decision === "dismissed") return req;
  let current = await approvals.update(root, transition(req, answer.decision, { by: answer.by }));
  if (current.status !== "approved") return current;
  try {
    await rotate(current.resource);
  } catch (error) {
    await approvals.update(root, transition(current, "fail"));
    throw error;
  }
  current = await approvals.update(root, transition(current, "rotated"));
  return current;
}
