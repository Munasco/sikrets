import { useState } from "react";
import { Fingerprint, ShieldCheck, X } from "lucide-react";
import { needsAnswer, sikrets, type Approval } from "../api.ts";
import { ago, Button, Chip, Empty, ErrorLine, message, shown, until, useLoad, useRefresh, useToast, cn } from "../ui.tsx";

// Doorman requests waiting for a person. Approve asks for Touch ID, then rotates; deny leaves the
// key as it is. A failed rotation can be approved again (retry) or denied.

const TONE = { pending: "warn", rotating: "info", rotated: "good", denied: "plain", expired: "info", failed: "bad" } as const;

export function Approvals() {
  const [all, setAll] = useState(false);
  const list = useLoad(() => sikrets<Approval[]>(["approvals", "list", ...(all ? ["--all"] : [])]), [all]);
  const data = shown(list);

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-dim">Nothing rotates until you approve.</p>
        <div className="flex rounded-md border border-line bg-white p-0.5 text-[12px]" role="tablist">
          {[
            [false, "Pending"],
            [true, "All"],
          ].map(([v, label]) => (
            <button key={String(v)} role="tab" aria-selected={all === v} type="button" onClick={() => setAll(v as boolean)} className={cn("h-6 rounded px-2.5", all === v ? "bg-cream text-ink" : "text-dim hover:text-ink")}>
              {label as string}
            </button>
          ))}
        </div>
      </div>
      {list.status === "error" && <ErrorLine error={list.error} />}
      <div className="flex flex-col gap-2">
        {data?.map((a) => <Request key={a.id} req={a} />)}
        {list.status === "ready" && !list.data.length && (
          <div className="rounded-lg border border-line bg-white">
            <Empty icon={<ShieldCheck className="size-4" />} title="Nothing waiting" />
          </div>
        )}
      </div>
    </div>
  );
}

function Request({ req: a }: { req: Approval }) {
  const toast = useToast();
  // Reloads every screen, the sidebar badge and the menu-bar count, not just this list.
  const refresh = useRefresh();
  const [busy, setBusy] = useState<"approve" | "deny">();

  async function act(kind: "approve" | "deny") {
    setBusy(kind);
    try {
      const out = await sikrets<Approval>(["approvals", kind, a.id]);
      if (out.status === "rotated") toast(`Approved · ${a.resource} rotated`);
      else if (out.status === "denied") toast(`Denied · ${a.resource} unchanged`);
      else toast("No answer; still waiting");
    } catch (e) {
      // A rotation that fails after approval exits non-zero; the request is now "failed" and can be retried.
      toast(kind === "approve" ? `Rotation of ${a.resource} failed: ${message(e)}` : message(e), "bad");
    } finally {
      setBusy(undefined);
      refresh();
    }
  }

  return (
    <div className="rise flex items-center gap-4 rounded-lg border border-line bg-white px-4 py-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-cream text-forest">
        <ShieldCheck className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12.5px]">{a.resource}</span>
          <Chip tone={TONE[a.status]}>{a.status}</Chip>
        </div>
        <p className="mt-0.5 text-[12.5px] text-ink-soft">{a.message}</p>
        {a.status === "failed" && a.error && <p className="selectable mt-0.5 text-[12px] text-rust">{a.error}</p>}
      </div>
      <div className="text-right font-mono text-[11px] text-dim">
        <div>{ago(a.createdAt)}</div>
        {needsAnswer(a) && <div>expires {until(a.expiresAt)}</div>}
        {a.decidedBy && <div>via {a.decidedBy}</div>}
      </div>
      {needsAnswer(a) && (
        <div className="flex gap-1.5">
          <Button variant="quiet" busy={busy === "deny"} disabled={!!busy} onClick={() => act("deny")} aria-label={`Deny ${a.id}`}>
            <X className="size-3.5" /> Deny
          </Button>
          <Button variant="primary" busy={busy === "approve"} disabled={!!busy} onClick={() => act("approve")} aria-label={`Approve ${a.id} with Touch ID`}>
            {busy !== "approve" && <Fingerprint className="size-3.5" />} {a.status === "failed" ? "Retry" : "Approve"}
          </Button>
        </div>
      )}
    </div>
  );
}
