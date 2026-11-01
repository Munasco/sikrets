import { useState } from "react";
import { Fingerprint, ShieldCheck, X } from "lucide-react";
import { sikrets, type Approval } from "../api.ts";
import { ago, Button, Chip, Empty, ErrorLine, message, until, useLoad, useToast, cn } from "../ui.tsx";

// Doorman requests waiting for a person. Approve asks for Touch ID, then rotates; deny leaves the
// key as it is.

const TONE = { pending: "warn", rotated: "good", approved: "good", denied: "plain", expired: "info", failed: "bad" } as const;

export function Approvals() {
  const [all, setAll] = useState(false);
  const { data, error, loading, reload } = useLoad(() => sikrets<Approval[]>(["approvals", "list", ...(all ? ["--all"] : [])]), [all]);

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
      <ErrorLine error={error} />
      <div className="flex flex-col gap-2">
        {data?.map((a) => <Request key={a.id} req={a} onDone={reload} />)}
        {!loading && !error && !data?.length && (
          <div className="rounded-lg border border-line bg-white">
            <Empty icon={<ShieldCheck className="size-4" />} title="Nothing waiting" />
          </div>
        )}
      </div>
    </div>
  );
}

function Request({ req: a, onDone }: { req: Approval; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "deny">();

  async function act(kind: "approve" | "deny") {
    setBusy(kind);
    try {
      const out = await sikrets<Approval>(["approvals", kind, a.id]);
      if (out.status === "rotated") toast(`Approved · ${a.resource} rotated`);
      else if (out.status === "denied") toast(`Denied · ${a.resource} unchanged`);
      else if (out.status === "failed") toast(`Approved, but the rotation failed`, "bad");
      else toast("No answer; still waiting");
      onDone();
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(undefined);
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
      </div>
      <div className="text-right font-mono text-[11px] text-dim">
        <div>{ago(a.createdAt)}</div>
        {a.status === "pending" && <div>expires {until(a.expiresAt)}</div>}
        {a.decidedBy && <div>via {a.decidedBy}</div>}
      </div>
      {a.status === "pending" && (
        <div className="flex gap-1.5">
          <Button variant="quiet" busy={busy === "deny"} disabled={!!busy} onClick={() => act("deny")} aria-label={`Deny ${a.id}`}>
            <X className="size-3.5" /> Deny
          </Button>
          <Button variant="primary" busy={busy === "approve"} disabled={!!busy} onClick={() => act("approve")} aria-label={`Approve ${a.id} with Touch ID`}>
            {busy !== "approve" && <Fingerprint className="size-3.5" />} Approve
          </Button>
        </div>
      )}
    </div>
  );
}
