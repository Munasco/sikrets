import { useState, type FormEvent } from "react";
import { Globe, Plus, ShieldCheck, Trash2, Undo2, X } from "lucide-react";
import { sikrets, type Grant, type Login } from "../api.ts";
import { ago, Button, Chip, Empty, ErrorLine, Field, IconButton, Input, message, Panel, useLoad, useToast } from "../ui.tsx";

// Website logins agents sign in with but never see. The password and 2FA secret go to the
// keychain through the CLI's stdin; this window never shows them again.

export function Logins() {
  const logins = useLoad(() => sikrets<Login[]>(["logins", "ls"]));
  const grants = useLoad(() => sikrets<Grant[]>(["logins", "grants"]));
  const [adding, setAdding] = useState(false);
  const reload = () => (logins.reload(), grants.reload());

  return (
    <div className="flex flex-col gap-4 p-5">
      {adding ? (
        <AddLogin onClose={() => setAdding(false)} onAdded={() => (setAdding(false), reload())} />
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-[12.5px] text-dim">Agents sign in with these. You approve each agent once.</p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> Add login
          </Button>
        </div>
      )}
      <ErrorLine error={logins.error} />
      <Panel title="Logins">
        {logins.data?.map((l) => <LoginLine key={l.name} login={l} onChange={reload} />)}
        {!logins.loading && !logins.error && !logins.data?.length && <Empty icon={<Globe className="size-4" />} title="No logins yet" />}
      </Panel>
      <Panel title="Agent grants">
        {grants.data?.map((g) => <GrantLine key={g.login + g.agent} grant={g} onChange={reload} />)}
        {!grants.loading && !grants.data?.length && <p className="px-3 py-4 text-[12.5px] text-dim">No standing grants. Each agent is asked on first use.</p>}
      </Panel>
    </div>
  );
}

function LoginLine({ login: l, onChange }: { login: Login; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      await sikrets(["logins", "rm", l.name]);
      toast(`Removed ${l.name}`);
      onChange();
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="group flex h-10 items-center gap-3 border-b border-line px-3 last:border-0 hover:bg-paper">
      <span className="w-36 font-mono text-[12px]">{l.name}</span>
      <span className="flex-1 truncate text-[12.5px] text-ink-soft">{l.origin}</span>
      {l.totp && <Chip tone="good">2FA</Chip>}
      <span className="w-20 text-right text-[12px] text-dim tabular-nums">{ago(l.addedAt)}</span>
      {confirming ? (
        <span className="flex gap-1">
          <Button variant="danger" busy={busy} onClick={remove}>Remove</Button>
          <IconButton label="Cancel" onClick={() => setConfirming(false)}>
            <X className="size-3.5" />
          </IconButton>
        </span>
      ) : (
        <IconButton label={`Remove ${l.name} and its grants`} onClick={() => setConfirming(true)} className="opacity-60 group-hover:opacity-100" side="left">
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function GrantLine({ grant: g, onChange }: { grant: Grant; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="group flex h-10 items-center gap-3 border-b border-line px-3 last:border-0 hover:bg-paper">
      <ShieldCheck className="size-3.5 text-pine" />
      <span className="w-36 font-mono text-[12px]">{g.agent}</span>
      <span className="flex-1 text-[12.5px] text-ink-soft">
        may sign in to <span className="font-mono text-[12px] text-ink">{g.login}</span>
      </span>
      <span className="w-20 text-right text-[12px] text-dim tabular-nums">{ago(g.grantedAt)}</span>
      <IconButton
        label={`Revoke ${g.agent}'s grant`}
        busy={busy}
        side="left"
        className="opacity-60 group-hover:opacity-100"
        onClick={async () => {
          setBusy(true);
          try {
            await sikrets(["logins", "revoke", g.login, "--agent", g.agent]);
            toast(`${g.agent} will be asked again`);
            onChange();
          } catch (e) {
            toast(message(e), "bad");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Undo2 className="size-3.5" />
      </IconButton>
    </div>
  );
}

function AddLogin({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", url: "", username: "" });
  // Held only until submit, then cleared; never rendered back.
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const stdin = totp ? `${password}\n${totp}\n` : `${password}\n`;
      await sikrets(["logins", "add", form.name, form.url, "--username", form.username, "--password-stdin", ...(totp ? ["--totp"] : [])], stdin);
      toast(`Stored ${form.name} in your keychain`);
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setPassword("");
      setTotp("");
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Panel
      title="New login"
      className="rise"
      actions={
        <IconButton label="Close" shortcut="esc" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      }
    >
      <form onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()} className="grid grid-cols-2 gap-3 p-3">
        <Field label="Name">
          <Input autoFocus required value={form.name} onChange={set("name")} placeholder="github" />
        </Field>
        <Field label="Sign-in URL">
          <Input required type="url" value={form.url} onChange={set("url")} placeholder="https://github.com/login" />
        </Field>
        <Field label="Username">
          <Input required value={form.username} onChange={set("username")} placeholder="me@acme.dev" />
        </Field>
        <Field label="Password">
          <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="2FA secret · optional" className="col-span-2">
          <Input type="password" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="otpauth:// URI or base32" />
        </Field>
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
        <div className="col-span-2 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy}>Save to keychain</Button>
        </div>
      </form>
    </Panel>
  );
}
