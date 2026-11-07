import { useState, type FormEvent } from "react";
import { Bot, Plus, Ban, X } from "lucide-react";
import { sikrets, type Agent, type KeyRow, type Status } from "../api.ts";
import { ago, Button, Chip, cn, Empty, ErrorLine, Field, IconButton, Input, message, Panel, shown, until, useLoad, useToast } from "../ui.tsx";

// Scoped agent identities: which resources or keys each agent may be handed, and until when.

const EXPIRY = [
  ["", "Never"],
  ["1h", "1 hour"],
  ["1d", "1 day"],
  ["7d", "7 days"],
  ["30d", "30 days"],
] as const;

export function Agents() {
  const list = useLoad(() => sikrets<Agent[]>(["agent", "list"]));
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4 p-5">
      {adding ? (
        <AddAgent onClose={() => setAdding(false)} onAdded={() => (setAdding(false), list.reload())} />
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-[12.5px] text-dim">Each agent gets only its scope. Revoking one leaves the rest alone.</p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add agent
          </Button>
        </div>
      )}
      {list.status === "error" && <ErrorLine error={list.error} />}
      <div className="overflow-hidden rounded-lg border border-line bg-white">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-line">
              {["Agent", "Status", "Scope", "Added", "Expires", ""].map((h) => (
                <th key={h} className="label h-8 px-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown(list)?.map((a) => <AgentLine key={a.name + a.createdAt} agent={a} onChange={list.reload} />)}
          </tbody>
        </table>
        {list.status === "ready" && !list.data.length && <Empty icon={<Bot className="size-4" />} title="No agents yet" />}
      </div>
    </div>
  );
}

function AgentLine({ agent: a, onChange }: { agent: Agent; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  async function revoke() {
    setBusy(true);
    try {
      await sikrets(["agent", "revoke", a.name]);
      toast(`Revoked ${a.name}`);
      onChange();
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  return (
    <tr className={cn("group h-10 border-b border-line last:border-0 hover:bg-paper", a.status !== "active" && "text-dim")}>
      <td className="px-3 font-mono text-[12px]">{a.name}</td>
      <td className="px-3">
        <Chip tone={a.status === "active" ? "good" : a.status === "revoked" ? "bad" : "info"}>{a.status}</Chip>
      </td>
      <td className="px-3">
        <span className="flex flex-wrap gap-1">
          {a.scope.map((s) => (
            <Chip key={s}>{s}</Chip>
          ))}
        </span>
      </td>
      <td className="px-3 tabular-nums text-ink-soft">{ago(a.createdAt)}</td>
      <td className="px-3 tabular-nums text-ink-soft">{a.revokedAt ? `revoked ${ago(a.revokedAt)}` : until(a.expiresAt)}</td>
      <td className="w-[120px] px-2 text-right">
        {a.status === "active" &&
          (confirming ? (
            <span className="inline-flex gap-1">
              <Button variant="danger" busy={busy} onClick={revoke}>Revoke</Button>
              <IconButton label="Cancel" onClick={() => setConfirming(false)}>
                <X className="size-3.5" />
              </IconButton>
            </span>
          ) : (
            <IconButton label={`Revoke ${a.name}`} onClick={() => setConfirming(true)} className="opacity-60 group-hover:opacity-100" side="left">
              <Ban className="size-3.5" />
            </IconButton>
          ))}
      </td>
    </tr>
  );
}

function AddAgent({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const options = useLoad(async () => {
    const [status, inv] = await Promise.all([sikrets<Status>(["status"]), sikrets<{ keys: KeyRow[] }>(["inventory", "--offline"])]);
    return [...status.resources.map((r) => r.name), ...inv.keys.map((k) => k.key)].filter((x, i, all) => all.indexOf(x) === i);
  });
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await sikrets(["agent", "add", name, ...scope.flatMap((s) => ["--key", s]), ...(expires ? ["--expires", expires] : [])]);
      toast(`Added ${name}`);
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (s: string) => setScope((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));

  return (
    <Panel
      title="New agent"
      className="rise"
      actions={
        <IconButton label="Close" shortcut="esc" disabled={busy} onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      }
    >
      <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && !busy && onClose()} className="flex flex-col gap-3 p-3">
        <div className="flex gap-3">
          <Field label="Name" className="w-56">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="claude-code" pattern="[a-z0-9-]+" required />
          </Field>
          <Field label="Expires" className="w-36">
            <select value={expires} onChange={(e) => setExpires(e.target.value)} className="h-7 rounded-md border border-line bg-white px-2 text-[12.5px]">
              {EXPIRY.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={`Scope · ${scope.length} selected`}>
          <div className="flex flex-wrap gap-1.5">
            {shown(options)?.map((s) => (
              <button key={s} type="button" aria-pressed={scope.includes(s)} onClick={() => toggle(s)} className={cn("h-6 rounded-md border px-2 font-mono text-[11px] transition-colors", scope.includes(s) ? "border-forest bg-forest text-cream" : "border-line bg-white text-ink-soft hover:bg-cream")}>
                {s}
              </button>
            ))}
            {options.status === "ready" && !options.data.length && <span className="text-[12px] text-dim">No keys in this project yet.</span>}
          </div>
        </Field>
        <ErrorLine error={error ?? (options.status === "error" ? options.error : undefined)} />
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy} disabled={!name || !scope.length}>Add agent</Button>
        </div>
      </form>
    </Panel>
  );
}
