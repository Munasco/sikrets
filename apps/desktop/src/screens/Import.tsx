import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import { FileUp, Link2, Plug } from "lucide-react";
import { chooseFile, sikrets, type ImportPreview, type LinkedKey, type ManagerId, type ManagerStatus } from "../api.ts";
import { step, type Source } from "./import-wizard.ts";
import { Button, Chip, cn, ErrorLine, Field, Input, Panel, shown, Tip, useLoad, useRefresh, useToast } from "../ui.tsx";

// Import from an export file or a password manager. The preview is a dry run: names only.
// Connecting Vaultwarden or 1Password signs in their CLI; the session goes to the keychain.
// The wizard's states live in import-wizard.ts. The import passes the preview's digest back, so
// the CLI refuses if the list changed (a new item, another prefix, a key that now exists). The
// screen is remounted when the project changes, so a preview never commits into another project.

const arg = (s: Source) => (s.kind === "file" ? s.path : s.id);
const prefixArgs = (prefix: string) => (prefix ? ["--prefix", prefix] : []);

export function Import() {
  const toast = useToast();
  const refresh = useRefresh();
  const [w, dispatch] = useReducer(step, { phase: "idle" });
  // The prefix field only edits the next preview; the one in `w` is what gets imported.
  const [prefix, setPrefix] = useState("");
  const seq = useRef(0);
  const linked = useLoad(() => sikrets<LinkedKey[]>(["link"]));

  const busy = w.phase === "previewing" || w.phase === "importing";
  const frozen = w.phase === "previewing" || w.phase === "previewed" || w.phase === "importing";
  const preview = w.phase === "previewed" || w.phase === "importing" ? w.preview : w.phase === "failed" ? w.preview : undefined;
  const source = w.phase === "idle" ? undefined : w.source;

  async function load(s: Source) {
    if (w.phase === "importing") return;
    const n = ++seq.current;
    const p = prefix;
    dispatch({ type: "preview", seq: n, source: s, prefix: p });
    try {
      dispatch({ type: "previewed", seq: n, preview: await sikrets<ImportPreview>(["import", arg(s), "--dry-run", ...prefixArgs(p)]) });
    } catch (error) {
      dispatch({ type: "previewFailed", seq: n, error });
    }
  }

  async function commit() {
    if (w.phase !== "previewed") return;
    const { source: s, prefix: p, preview: shownPreview } = w;
    dispatch({ type: "import" });
    try {
      const out = await sikrets<ImportPreview>(["import", arg(s), "--yes", ...prefixArgs(p), ...(shownPreview.digest ? ["--expect", shownPreview.digest] : [])]);
      dispatch({ type: "imported" });
      toast(`Imported ${out.keys.length} key(s)${s.kind === "file" ? ". Delete the export file now" : ""}`);
      refresh();
    } catch (error) {
      dispatch({ type: "importFailed", error });
    }
  }

  const linkedRows = shown(linked);
  return (
    <div className="grid grid-cols-[1fr_300px] gap-4 p-5">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="From a file">
          <div className="flex items-end gap-3 p-3">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const path = await chooseFile();
                if (path) load({ kind: "file", path });
              }}
              className="flex h-16 flex-1 items-center justify-center gap-2 rounded-md border border-dashed border-line bg-paper text-[12.5px] text-ink-soft hover:border-pine/40 hover:bg-cream disabled:opacity-50"
            >
              <FileUp className="size-4 text-dim" />
              {source?.kind === "file" ? <span className="truncate font-mono text-[12px]">{source.path}</span> : "Choose .env, CSV, JSON or .1pux"}
            </button>
            <Field label="Prefix · optional" className="w-36">
              <Input value={frozen ? w.prefix : prefix} disabled={frozen} title={frozen ? "Cancel the preview to change the prefix" : undefined} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="BW" />
            </Field>
          </div>
        </Panel>

        {w.phase === "failed" && <ErrorLine error={w.error} />}

        {(preview || w.phase === "previewing") && (
          <Panel
            title={preview ? `${preview.keys.length} keys · ${preview.format}` : "Reading…"}
            className="rise"
            actions={
              preview && (
                <>
                  <Button disabled={w.phase === "importing"} onClick={() => dispatch({ type: "cancel" })}>Cancel</Button>
                  {w.phase !== "failed" && (
                    <Button variant="primary" busy={w.phase === "importing"} onClick={commit}>
                      Import {preview.keys.length}
                    </Button>
                  )}
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
        <Connect busy={busy} onPreview={(id) => load({ kind: "manager", id })} />
        <Panel title="Linked keys">
          {linked.status === "error" && (
            <div className="p-3">
              <ErrorLine error={linked.error} />
            </div>
          )}
          {linkedRows?.map((l) => (
            <div key={l.key} className="flex h-9 items-center gap-2 border-b border-line px-3 last:border-0" title={l.ref}>
              <Link2 className="size-3 shrink-0 text-pine" />
              <span className="flex-1 truncate font-mono text-[11.5px]">{l.key}</span>
              {l.sync.state === "pending" && (
                <Tip label={`The rotated value isn't in the password manager yet${l.sync.error ? `: ${l.sync.error}` : ""}. Retry with: sikrets link --push`} side="left">
                  <Chip tone="bad">not written back</Chip>
                </Tip>
              )}
            </div>
          ))}
          {linked.status === "ready" && !linked.data.length && <p className="px-3 py-3 text-[12px] text-dim">None yet. Manager imports link automatically.</p>}
        </Panel>
      </div>
    </div>
  );
}

const TABS = [
  ["bitwarden", "Vaultwarden"],
  ["1password", "1Password"],
] as const satisfies readonly (readonly [ManagerId, string])[];

const STATE_TEXT: Record<ManagerStatus["state"], string> = { unauthenticated: "Not signed in", locked: "Locked", expired: "Session expired", unlocked: "Signed in" };

/** Sign-in state per manager, read from the CLI (`unlock <m> --status`), so it survives remounts. */
function Connect({ onPreview, busy: importBusy }: { onPreview: (id: ManagerId) => void; busy: boolean }) {
  const toast = useToast();
  const [tab, setTab] = useState<ManagerId>("bitwarden");
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState<ManagerId>();
  const [error, setError] = useState<{ manager: ManagerId; error: unknown }>();
  const [status, setStatus] = useState<Partial<Record<ManagerId, ManagerStatus | "unknown">>>({});

  const check = (m: ManagerId) =>
    sikrets<ManagerStatus>(["unlock", m, "--status"]).then(
      (s) => setStatus((x) => ({ ...x, [m]: s })),
      () => setStatus((x) => ({ ...x, [m]: "unknown" })),
    );
  useEffect(() => {
    void check(tab);
  }, [tab]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Everything below is about the tab that was submitted, even if another is open by the time it answers.
    const m = tab;
    setSubmitting(m);
    setError(undefined);
    try {
      if (m === "bitwarden") await sikrets(["unlock", "vaultwarden", ...(server ? ["--server", server] : []), ...(email ? ["--email", email] : []), "--password-stdin"], `${password}\n`);
      else await sikrets(["unlock", "1password"]);
      toast(`Connected ${m === "bitwarden" ? "Vaultwarden" : "1Password"}`);
    } catch (err) {
      setError({ manager: m, error: err });
    } finally {
      setPassword("");
      setSubmitting(undefined);
      void check(m);
    }
  }

  const s = status[tab];
  const signedIn = s && s !== "unknown" && s.state === "unlocked" ? s.account : undefined;
  return (
    <Panel title="Connect a vault">
      <div className="flex gap-1 border-b border-line p-1.5" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cn("h-6 flex-1 rounded text-[12px]", tab === t ? "bg-cream text-ink" : "text-dim hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2.5 p-3">
        {tab === "bitwarden" ? (
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
        {error?.manager === tab && <ErrorLine error={error.error} />}
        <div className="flex gap-2">
          <Button variant="primary" type="submit" busy={submitting === tab} disabled={submitting !== undefined} className="flex-1 justify-center">
            <Plug className="size-3.5" /> {signedIn ? "Reconnect" : "Connect"}
          </Button>
          <Button disabled={importBusy} onClick={() => onPreview(tab)}>Preview</Button>
        </div>
        {s && s !== "unknown" && (
          <p className={cn("text-[11.5px]", s.state === "unlocked" ? "text-pine" : "text-dim")}>
            {s.state === "unlocked" ? `Signed in as ${s.account}` : `${STATE_TEXT[s.state]}${s.account ? ` · ${s.account}` : ""}`}
          </p>
        )}
      </form>
    </Panel>
  );
}

