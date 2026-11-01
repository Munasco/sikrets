import { useState, type FormEvent } from "react";
import { FileUp, Link2, Plug } from "lucide-react";
import { chooseFile, sikrets, type ImportPreview } from "../api.ts";
import { Button, Chip, cn, ErrorLine, Field, Input, message, Panel, useLoad, useToast } from "../ui.tsx";

// Import from an export file or a password manager. The preview is a dry run: names only.
// Connecting Vaultwarden or 1Password signs in their CLI; the session goes to the keychain.

type Source = { kind: "file"; path: string } | { kind: "manager"; id: "bitwarden" | "1password" };

export function Import() {
  const toast = useToast();
  const [source, setSource] = useState<Source>();
  const [prefix, setPrefix] = useState("");
  const [preview, setPreview] = useState<ImportPreview>();
  const [busy, setBusy] = useState<"preview" | "import">();
  const [error, setError] = useState<unknown>();
  const linked = useLoad(() => sikrets<{ key: string; ref: string }[]>(["link"]));

  const arg = (s: Source) => (s.kind === "file" ? s.path : s.id);
  const prefixArgs = prefix ? ["--prefix", prefix] : [];

  async function load(s: Source) {
    setSource(s);
    setPreview(undefined);
    setError(undefined);
    setBusy("preview");
    try {
      setPreview(await sikrets<ImportPreview>(["import", arg(s), "--dry-run", ...prefixArgs]));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  }

  async function commit() {
    if (!source) return;
    setBusy("import");
    try {
      const out = await sikrets<ImportPreview>(["import", arg(source), "--yes", ...prefixArgs]);
      toast(`Imported ${out.keys.length} key(s)${source.kind === "file" ? ". Delete the export file now" : ""}`);
      setPreview(undefined);
      setSource(undefined);
      linked.reload();
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="grid grid-cols-[1fr_300px] gap-4 p-5">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="From a file">
          <div className="flex items-end gap-3 p-3">
            <button
              type="button"
              onClick={async () => {
                const path = await chooseFile();
                if (path) load({ kind: "file", path });
              }}
              className="flex h-16 flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-paper text-[12.5px] text-ink-soft hover:border-pine/40 hover:bg-cream"
            >
              <FileUp className="size-4 text-dim" />
              {source?.kind === "file" ? <span className="truncate font-mono text-[12px]">{source.path}</span> : "Choose .env, CSV, JSON or .1pux"}
            </button>
            <Field label="Prefix · optional" className="w-36">
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="BW" />
            </Field>
          </div>
        </Panel>

        <ErrorLine error={error} />

        {(preview || busy === "preview") && (
          <Panel
            title={preview ? `${preview.keys.length} keys · ${preview.format}` : "Reading…"}
            className="rise"
            actions={
              preview && (
                <>
                  <Button onClick={() => (setPreview(undefined), setSource(undefined))}>Cancel</Button>
                  <Button variant="primary" busy={busy === "import"} onClick={commit}>
                    Import {preview.keys.length}
                  </Button>
                </>
              )
            }
          >
            <ul className="scroll-thin max-h-[360px] overflow-y-auto">
              {preview?.keys.map((k) => {
                const replaces = preview.replaced.includes(k);
                return (
                  <li key={k} className="flex h-8 items-center gap-2 border-b border-line px-3 last:border-0">
                    <span className={cn("w-3 font-mono text-[12px]", replaces ? "text-amber" : "text-pine")}>{replaces ? "~" : "+"}</span>
                    <span className="flex-1 font-mono text-[12px]">{k}</span>
                    {replaces && <Chip tone="warn">replaces current</Chip>}
                  </li>
                );
              })}
              {!preview && <li className="h-20 animate-pulse bg-cream/40" />}
            </ul>
          </Panel>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Connect onPreview={(id) => load({ kind: "manager", id })} />
        <Panel title="Linked keys">
          {linked.data?.map((l) => (
            <div key={l.key} className="flex h-9 items-center gap-2 border-b border-line px-3 last:border-0" title={l.ref}>
              <Link2 className="size-3 shrink-0 text-pine" />
              <span className="truncate font-mono text-[11.5px]">{l.key}</span>
            </div>
          ))}
          {!linked.loading && !linked.data?.length && <p className="px-3 py-3 text-[12px] text-dim">None yet. Manager imports link automatically.</p>}
        </Panel>
      </div>
    </div>
  );
}

function Connect({ onPreview }: { onPreview: (id: "bitwarden" | "1password") => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<"vaultwarden" | "1password">("vaultwarden");
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [account, setAccount] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const out =
        tab === "vaultwarden"
          ? await sikrets<{ account: string }>(["unlock", "vaultwarden", ...(server ? ["--server", server] : []), ...(email ? ["--email", email] : []), "--password-stdin"], `${password}\n`)
          : await sikrets<{ account: string }>(["unlock", "1password"]);
      setAccount(out.account);
      toast(`Connected ${tab === "vaultwarden" ? "Vaultwarden" : "1Password"}`);
    } catch (err) {
      setError(err);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <Panel title="Connect a vault">
      <div className="flex gap-1 border-b border-line p-1.5" role="tablist">
        {(["vaultwarden", "1password"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => (setTab(t), setAccount(undefined), setError(undefined))} className={cn("h-6 flex-1 rounded text-[12px]", tab === t ? "bg-cream text-ink" : "text-dim hover:text-ink")}>
            {t === "vaultwarden" ? "Vaultwarden" : "1Password"}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2.5 p-3">
        {tab === "vaultwarden" ? (
          <>
            <Field label="Server">
              <Input type="url" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://vault.acme.dev" />
            </Field>
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="me@acme.dev" />
            </Field>
            <Field label="Master password">
              <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        ) : (
          <p className="text-[12px] text-dim">Signs in with the 1Password app (needs the op CLI).</p>
        )}
        <ErrorLine error={error} />
        <div className="flex gap-2">
          <Button variant="primary" type="submit" busy={busy} className="flex-1 justify-center">
            <Plug className="size-3.5" /> {account ? "Reconnect" : "Connect"}
          </Button>
          <Button onClick={() => onPreview(tab === "vaultwarden" ? "bitwarden" : "1password")}>Preview</Button>
        </div>
        {account && <p className="text-[11.5px] text-pine">Signed in as {account}</p>}
      </form>
    </Panel>
  );
}
