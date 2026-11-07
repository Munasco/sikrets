import { useEffect, useRef, useState } from "react";
import { KeyRound, Link2, RotateCw, Search } from "lucide-react";
import { sikrets, type Approval, type KeyRow } from "../api.ts";
import type { Route } from "../App.tsx";
import { ago, Chip, CopyButton, Empty, ErrorLine, IconButton, Kbd, message, shown, Tip, useLoad, useRefresh, useToast } from "../ui.tsx";

// The inventory: every stored key with its age and use. Names and dates only, never a value.
// Rotating files a Doorman request, which asks for Touch ID before anything changes.

export function Keys({ go }: { go: (r: Route) => void }) {
  const inventory = useLoad(() => sikrets<{ keys: KeyRow[] }>(["inventory"]));
  const data = shown(inventory);
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = (data?.keys ?? []).filter((r) => !q || `${r.key} ${r.resource} ${r.source ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const stale = data?.keys.filter((r) => r.stale).length ?? 0;
  const over = data?.keys.filter((r) => r.scope?.overScoped).length ?? 0;

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-4 text-[12.5px]">
          <Stat n={data?.keys.length} label="keys" />
          <Stat n={stale} label="stale" tone={stale ? "warn" : undefined} />
          <Stat n={over} label="over-scoped" tone={over ? "bad" : undefined} />
        </div>
        <label className="relative ml-auto w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" />
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (setQ(""), e.currentTarget.blur())} placeholder="Filter" aria-label="Filter keys" className="h-7 w-full rounded-md border border-line bg-white pr-7 pl-7 text-[12.5px] placeholder:text-muted focus:border-pine/40 focus:outline-none" />
          <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2">/</Kbd>
        </label>
      </div>

      {inventory.status === "error" && <ErrorLine error={inventory.error} />}

      <div className="scroll-thin overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-[12.5px] whitespace-nowrap">
          <thead>
            <tr className="border-b border-line">
              {["Key", "From", "Age", "Rotated", "Last used", "Used by", "Flags", ""].map((h) => (
                <th key={h} className="label h-8 px-2.5 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <KeyLine key={r.key} row={r} go={go} />
            ))}
          </tbody>
        </table>
        {inventory.status === "ready" && !rows.length && (
          <Empty icon={<KeyRound className="size-4" />} title={q ? "No keys match" : "No keys yet"}>
            {!q && <>Add one with <span className="font-mono">sikrets add</span>, or use Import.</>}
          </Empty>
        )}
        {inventory.status === "loading" && !data && <div className="h-24 animate-pulse bg-cream/40" />}
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n?: number; label: string; tone?: "warn" | "bad" }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={tone === "bad" ? "font-mono text-[15px] text-rust" : tone === "warn" ? "font-mono text-[15px] text-amber" : "font-mono text-[15px] text-ink"}>{n ?? "–"}</span>
      <span className="text-dim">{label}</span>
    </span>
  );
}

function KeyLine({ row: r, go }: { row: KeyRow; go: (r: Route) => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const usedBy = [...r.apps, ...r.agents.map((a) => `agent:${a}`)];
  const imported = !r.resource;

  async function rotate() {
    setBusy(true);
    try {
      // Doorman: Touch ID (or a dialog) first, then the rotation itself.
      const out = await sikrets<Approval>(["approvals", "request", r.resource, "--reason", "requested"]);
      if (out.status === "rotated") toast(`Rotated ${r.resource}`);
      else if (out.status === "denied") toast(`Not rotated: denied`, "bad");
      else if (out.status === "failed") toast(`Rotation of ${r.resource} failed`, "bad");
      else {
        toast(`Waiting for approval`);
        go("approvals");
      }
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(false);
      refresh(); // keys, approvals and the pending badge all changed
    }
  }

  return (
    <tr className="group h-10 border-b border-line last:border-0 hover:bg-paper">
      <td className="px-2.5 font-mono text-[12px] text-ink">{r.key}</td>
      <td className="px-2.5 text-ink-soft">
        {imported ? (
          <span className="inline-flex items-center gap-1">
            {r.ref && (
              <Tip label={`Linked: rotations write back to ${r.ref}`}>
                <Link2 className="size-3 text-pine" aria-label="Linked" />
              </Tip>
            )}
            {r.source}
          </span>
        ) : (
          r.resource
        )}
      </td>
      <td className="px-2.5 text-ink-soft tabular-nums">{ago(r.createdAt).replace(" ago", "")}</td>
      <td className="px-2.5 text-ink-soft tabular-nums">{r.lastRotatedAt ? ago(r.lastRotatedAt) : <span className="text-muted">never</span>}</td>
      <td className="px-2.5 text-ink-soft tabular-nums">{r.lastUsed ? ago(r.lastUsed) : <span className="text-muted">never</span>}</td>
      <td className="px-2.5">
        <span className="inline-block max-w-[120px] truncate align-middle text-ink-soft" title={usedBy.join(", ")}>{usedBy.join(", ") || <span className="text-muted">—</span>}</span>
      </td>
      <td className="px-2.5">
        <span className="flex gap-1">
          {r.stale && (
            <Tip label="Older than 90 days and unused for 30">
              <Chip tone="warn">stale</Chip>
            </Tip>
          )}
          {r.scope?.overScoped && (
            <Tip label={r.scope.detail}>
              <Chip tone="bad">broad</Chip>
            </Tip>
          )}
          {!r.stale && !r.scope?.overScoped && <Chip tone="good">ok</Chip>}
        </span>
      </td>
      <td className="w-[84px] px-2">
        <span className="flex justify-end gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={`\${${r.key}}`} label={`Copy reference \${${r.key}}`} side="left" />
          <IconButton label={imported ? "Imported: rotate at its source" : `Rotate ${r.resource} (Touch ID)`} disabled={imported} busy={busy} onClick={rotate} side="left">
            <RotateCw className="size-3.5" />
          </IconButton>
        </span>
      </td>
    </tr>
  );
}
