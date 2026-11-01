import type { KeyView, RequestView } from "@sikrets/pairing";

export function timeLeft(iso: string, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.max(1, Math.round((ms % 3_600_000) / 60_000));
  return h ? `${h}h left` : `${m}m left`;
}

export function statusBadge(req: RequestView, sent?: "approve" | "deny"): { label: string; tone: "pending" | "good" | "bad" | "quiet" } {
  if (req.challenge && sent) return { label: sent === "approve" ? "Approved, rotating…" : "Denied", tone: "quiet" };
  switch (req.status) {
    case "pending":
      return { label: "Waiting", tone: "pending" };
    case "failed":
      return { label: "Rotation failed", tone: "bad" };
    case "rotated":
      return { label: "Rotated", tone: "good" };
    case "approved":
      return { label: "Rotating", tone: "good" };
    case "denied":
      return { label: "Denied", tone: "quiet" };
    default:
      return { label: req.status, tone: "quiet" };
  }
}

export const keyTone = (k: KeyView) => (k.status === "active" ? "good" : k.status === "rotation due" ? "pending" : "quiet");

export const shortDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined);
