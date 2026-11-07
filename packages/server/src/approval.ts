import { createHash, timingSafeEqual } from "node:crypto";
import type { SignIn } from "./store.ts";

// Who approves a new device. Sign-in itself (start, poll, collect) is the same for every policy;
// only these two decisions change. `auto` is for one person on their own machine: every sign-in
// belongs to the local account at once. `manual` leaves sign-ins pending until someone approves
// them at the approval endpoint: a device already signed in to the account, or an operator with
// the admin token. A browser sign-in (OAuth, passkeys) is another policy whose `approver` reads
// the browser session.

export interface ApprovalPolicy {
  readonly mode: "auto" | "manual";
  /** The account a new sign-in is approved as straight away, or undefined to leave it pending. */
  onStart(signIn: SignIn): string | undefined;
  /**
   * The account approving at the approval endpoint, or undefined if the caller may not.
   * `device` is the account of the signed-in device making the request, if it sent a valid proof;
   * `requested` is the account the caller asked for.
   */
  approver(req: Request, ctx: { device?: string; requested?: string }): string | undefined;
}

export function autoApproval(user: string): ApprovalPolicy {
  return {
    mode: "auto",
    onStart: () => user,
    approver: ({}, { device }) => device,
  };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function manualApproval(opts: { adminToken?: string } = {}): ApprovalPolicy {
  const admin = opts.adminToken ? digest(opts.adminToken) : undefined;
  const isAdmin = (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    if (!admin || !header.startsWith("Bearer ")) return false;
    return timingSafeEqual(digest(header.slice("Bearer ".length)), admin);
  };
  return {
    mode: "manual",
    onStart: () => undefined,
    approver(req, { device, requested }) {
      // A signed-in device approves new devices for its own account only.
      if (device) return device;
      if (requested && isAdmin(req)) return requested;
      return undefined;
    },
  };
}
