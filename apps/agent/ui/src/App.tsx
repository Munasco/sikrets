import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, ChevronRight, KeyRound, Zap, PanelLeft, Search, ShieldCheck, ShieldQuestion, Sparkles, Square, SquarePen } from "lucide-react";
import { api, ApiError, subscribe, type AssistantPart, type Attestation, type Me, type Message, type OcEvent, type PermissionRequest, type SessionInfo, type ToolPart } from "./api.ts";
import { Markdown, withSecrets } from "./markdown.tsx";
import { ToolRow } from "./tools.tsx";
import { cn, IconButton, Kbd, Logo, Tip } from "./ui.tsx";

// The chat client, laid out the way t3code does it (MIT, pingdotgg/t3code; layout and interaction
// ideas only, no code copied): a thread sidebar, a centred message lane, a composer that floats
// over the timeline (and sits mid-page on a new thread), tool calls as quiet work-log rows,
// approvals inline in the timeline, and keyboard shortcuts for the common moves.
// It talks to opencode's own API through the gateway; the gateway scopes everything to this login.

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

type Status = "working" | "approval" | "failed" | "unread" | undefined;

function ago(t: number | undefined) {
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const routeSession = () => /^#\/s\/(ses_[\w]+)/.exec(location.hash)?.[1];

export function App() {
  const [me, setMe] = useState<Me>();
  useEffect(() => void api.me().then(setMe, () => setMe({ authed: false, gated: true, model: "" })), []);
  if (!me) return null;
  if (!me.authed) return <Gate onIn={() => api.me().then(setMe)} />;
  return <Workspace model={me.model} fullAccess={Boolean(me.fullAccess)} />;
}

function Gate({ onIn }: { onIn: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api.login(code);
      onIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
    }
  };
  return (
    <main className="grid min-h-full place-items-center bg-paper px-4">
      <form onSubmit={submit} className="w-full max-w-[340px] rounded-2xl bg-cream p-6">
        <Logo className="size-7 text-pine" />
        <h1 className="display mt-5 text-[30px] text-forest">Security agent</h1>
        <label htmlFor="code" className="mt-5 block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">Access code</label>
        <input id="code" type="password" autoComplete="current-password" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-line bg-white px-3 outline-none focus:border-pine/40" />
        <button type="submit" className="mt-3 h-10 w-full rounded-full bg-pine font-medium text-white transition-colors hover:bg-pine-deep">Continue</button>
        <p role="alert" className="mt-2 min-h-5 text-[13px] text-rust">{error}</p>
      </form>
    </main>
  );
}

function Workspace({ model, fullAccess: initialAccess }: { model: string; fullAccess: boolean }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [current, setCurrent] = useState<string | undefined>(routeSession());
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [fullAccess, setFullAccess] = useState(initialAccess);
  const [working, setWorking] = useState<Record<string, number>>({});
  const [approvals, setApprovals] = useState<Record<string, boolean>>({});
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 768);
  const [live, setLive] = useState(true);
  const [sending, setSending] = useState<string>();
  const [attestation, setAttestation] = useState<Attestation>();
  const currentRef = useRef(current);
  currentRef.current = current;
  const composer = useRef<HTMLTextAreaElement>(null);

  const refreshSessions = useCallback(
    () =>
      api
        .sessions()
        .then((list) => {
          setSessions(list);
          // Runs that started before this page loaded (a reload, another tab) still show as working.
          const busy = Object.fromEntries(list.filter((s) => s.time.busy && (!s.time.idle || s.time.busy > s.time.idle)).map((s) => [s.id, s.time.busy!]));
          setWorking((w) => ({ ...busy, ...w }));
        })
        .catch(() => {}),
    [],
  );
  const load = useCallback(async (id: string) => {
    const [m, p] = await Promise.all([api.messages(id), api.permissions(id)]);
    if (currentRef.current !== id) return;
    setMessages(m);
    setPending(p);
  }, []);

  useEffect(() => {
    void refreshSessions();
    void api.attestation().then(setAttestation, () => {});
    const onHash = () => setCurrent(routeSession());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refreshSessions]);

  useEffect(() => {
    setMessages([]);
    setPending([]);
    setError("");
    if (!current) return;
    setUnread((u) => ({ ...u, [current]: false }));
    load(current).catch((e) => {
      if (e instanceof ApiError && e.status === 404) location.hash = "";
    });
  }, [current, load]);

  const open = (id?: string) => {
    location.hash = id ? `#/s/${id}` : "";
    if (window.innerWidth < 768) setSidebar(false);
    setTimeout(() => composer.current?.focus(), 0);
  };

  // Live updates: opencode's event stream, already narrowed to this login's sessions.
  useEffect(
    () =>
      subscribe((ev) => {
        const sid = ev.data.sessionID;
        if (ev.type === "session.execution.started" && sid) setWorking((w) => ({ ...w, [sid]: Date.now() }));
        if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(ev.type) && sid) {
          setWorking(({ [sid]: _, ...w }) => w);
          if (sid !== currentRef.current) setUnread((u) => ({ ...u, [sid]: true }));
          void refreshSessions();
          if (sid === currentRef.current) void load(sid);
        }
        if (ev.type === "permission.asked" && sid) {
          setApprovals((a) => ({ ...a, [sid]: true }));
          if (sid === currentRef.current) setPending((p) => [...p.filter((x) => x.id !== (ev.data as unknown as PermissionRequest).id), ev.data as unknown as PermissionRequest]);
        }
        if (ev.type === "permission.replied" && sid) {
          setApprovals(({ [sid]: _, ...a }) => a);
          setPending((p) => p.filter((x) => x.id !== ev.data.requestID));
        }
        if (ev.type === "session.renamed" || ev.type === "session.created") void refreshSessions();
        if (sid === currentRef.current) {
          setMessages((m) => apply(m, ev));
          if (ev.type === "session.step.failed" || ev.type === "session.execution.failed") setError(String((ev.data.error as { message?: string } | undefined)?.message ?? "The model request failed."));
        }
      }, setLive),
    [load, refreshSessions],
  );

  const send = async (text: string) => {
    setError("");
    let id = current;
    try {
      if (!id) {
        id = (await api.create()).id;
        currentRef.current = id;
        location.hash = `#/s/${id}`;
        setCurrent(id);
        void refreshSessions();
      }
      setSending(text);
      const admitted = (await api.prompt(id, text)) as { data?: { id: string; payload?: { text?: string } } };
      // Show what the agent got: the server's copy, with keys already swapped for placeholders.
      const msg = admitted?.data;
      if (msg?.payload?.text !== undefined) setMessages((m) => (m.some((x) => x.id === msg.id) ? m : [...m, { id: msg.id, type: "user", text: msg.payload!.text!, time: { created: Date.now() } }]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(undefined);
    }
  };

  const stop = () => current && void api.interrupt(current);

  const toggleAccess = async () => {
    try {
      setFullAccess((await api.fullAccess(!fullAccess)).fullAccess);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Shortcuts: new chat, toggle sidebar, previous/next chat, stop; typing anywhere goes to the composer.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") return e.preventDefault(), open();
      if (mod && e.key.toLowerCase() === "b") return e.preventDefault(), setSidebar((s) => !s);
      if (mod && e.shiftKey && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) {
        e.preventDefault();
        const i = sessions.findIndex((s) => s.id === current);
        const next = sessions[Math.min(sessions.length - 1, Math.max(0, i + (e.key === "]" || e.key === "}" ? 1 : -1)))];
        if (next) open(next.id);
        return;
      }
      if (e.key === "Escape" && current && working[current]) return stop();
      const target = e.target as HTMLElement;
      if (!mod && !e.altKey && e.key.length === 1 && !/INPUT|TEXTAREA/.test(target.tagName) && !target.isContentEditable) composer.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const status = (id: string): Status => (approvals[id] ? "approval" : working[id] ? "working" : unread[id] ? "unread" : sessions.find((s) => s.id === id)?.outcome === "failed" ? "failed" : undefined);
  const title = sessions.find((s) => s.id === current)?.title;
  const running = current ? working[current] : undefined;
  const empty = !current || (!messages.length && !sending);

  return (
    <div className="flex h-dvh overflow-hidden bg-paper">
      <Sidebar open={sidebar} sessions={sessions} current={current} status={status} working={working} onOpen={open} onClose={() => setSidebar(false)} />
      <section className="relative flex min-w-0 flex-1 flex-col bg-white md:my-2 md:mr-2 md:rounded-2xl md:border md:border-line-soft">
        <header className="flex h-[52px] shrink-0 items-center gap-2 px-3">
          {!sidebar && <IconButton label="Show sidebar" shortcut={`${MOD}B`} side="bottom" onClick={() => setSidebar(true)}><PanelLeft className="size-4" /></IconButton>}
          {!sidebar && <IconButton label="New chat" shortcut={`${MOD}N`} side="bottom" onClick={() => open()}><SquarePen className="size-4" /></IconButton>}
          <h1 className="min-w-0 truncate text-[13px] font-medium text-ink">{current ? (title ?? "Security chat") : <span className="text-faint">New chat</span>}</h1>
          <span className="flex-1" />
          {!live && <span className="font-mono text-[11px] text-faint">reconnecting…</span>}
          <EnclaveBadge attestation={attestation} />
        </header>

        <Timeline messages={messages} pending={pending} session={current} running={running} sending={sending} error={error} empty={empty} />

        <div className={cn("pointer-events-none absolute inset-x-0 z-20 px-3 sm:px-12", empty ? "inset-y-0 flex flex-col items-center justify-center" : "bottom-0 pb-3 pt-2")}>
          {empty && <Hero />}
          <Composer ref={composer} model={model} running={Boolean(running)} awaiting={pending.length > 0} fullAccess={fullAccess} onToggleAccess={toggleAccess} onSend={send} onStop={stop} />
        </div>
      </section>
    </div>
  );
}

function Sidebar({ open, sessions, current, status, working, onOpen, onClose }: { open: boolean; sessions: SessionInfo[]; current?: string; status: (id: string) => Status; working: Record<string, number>; onOpen: (id?: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const shown = sessions.filter((s) => (s.title ?? "Security chat").toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-ink/20 md:hidden" onClick={onClose} aria-hidden />}
      <aside aria-label="Chats" className={cn("z-40 flex w-[256px] shrink-0 flex-col bg-paper transition-[margin] duration-200 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(300px,calc(100vw-3rem))] max-md:shadow-xl", !open && "-ml-[256px] max-md:-ml-[300px]")}>
        <div className="flex h-[52px] items-center gap-2 px-3">
          <Logo className="size-[22px] text-pine" />
          <span className="display text-[19px] text-forest">Sikrets</span>
          <span className="flex-1" />
          <IconButton label="Hide sidebar" shortcut={`${MOD}B`} side="bottom" onClick={onClose}><PanelLeft className="size-4" /></IconButton>
          <IconButton label="New chat" shortcut={`${MOD}N`} side="bottom" onClick={() => onOpen()}><SquarePen className="size-4" /></IconButton>
        </div>
        <div className="px-2">
          <label className="flex h-8 items-center gap-2 rounded-md px-2 text-muted focus-within:bg-white">
            <Search className="size-4" aria-hidden />
            <span className="sr-only">Search chats</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint" />
          </label>
        </div>
        <nav className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
          <p className="flex h-8 items-center px-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">Chats</p>
          {shown.length === 0 && <p className="px-2.5 text-[12.5px] text-faint">{query ? "No matches" : "None yet"}</p>}
          {shown.map((s) => {
            const st = status(s.id);
            return (
              <button key={s.id} type="button" onClick={() => onOpen(s.id)} aria-current={s.id === current ? "page" : undefined} className={cn("group flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors", s.id === current ? "bg-white ring-1 ring-inset ring-line" : "hover:bg-cream")}>
                <StatusDot status={st} />
                <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", s.id === current ? "text-ink" : "text-ink-soft")}>{s.title ?? "Security chat"}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{st === "working" ? <Elapsed since={working[s.id]!} /> : ago(s.time.updated ?? s.time.created)}</span>
              </button>
            );
          })}
        </nav>
        <p className="flex items-center gap-1.5 px-4 pb-3 text-[11.5px] text-faint">
          <KeyRound className="size-3.5" aria-hidden />
          Keys you paste never reach the model.
        </p>
      </aside>
    </>
  );
}

function StatusDot({ status }: { status: Status }) {
  const style = { working: "bg-pine animate-pulse", approval: "bg-tan", failed: "bg-rust", unread: "bg-pine/60" } as const;
  const label = { working: "Working", approval: "Waiting for your approval", failed: "Failed", unread: "New reply" } as const;
  if (!status) return <span className="size-1.5 shrink-0" aria-hidden />;
  return <span className={cn("size-1.5 shrink-0 rounded-full", style[status])} role="img" aria-label={label[status]} title={label[status]} />;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{duration(Date.now() - since)}</>;
}

function EnclaveBadge({ attestation }: { attestation?: Attestation }) {
  if (!attestation) return null;
  const pcr0 = attestation.pcrs?.["0"];
  return attestation.enclave ? (
    <Tip side="bottom" label={<>Running in an AWS Nitro Enclave; the attestation is signed by its security module.<span className="mt-1 block break-all font-mono text-[10.5px] opacity-80">PCR0 {pcr0}</span></>}>
      <a href="/attestation" target="_blank" rel="noopener" className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-pine hover:bg-cream" aria-label="Enclave verified: view attestation">
        <ShieldCheck className="size-4" strokeWidth={1.75} aria-hidden />
        <span className="max-sm:hidden">Enclave verified</span>
      </a>
    </Tip>
  ) : (
    <Tip side="bottom" label="This server isn't running in an enclave, so there's no attestation.">
      <span tabIndex={0} className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-faint" aria-label="Not in an enclave">
        <ShieldQuestion className="size-4" strokeWidth={1.75} aria-hidden />
        <span className="max-sm:hidden">Not attested</span>
      </span>
    </Tip>
  );
}

function Hero() {
  return (
    <div className="pointer-events-auto mb-6 text-center">
      <Logo className="mx-auto size-9 text-pine" />
      <h2 className="display mt-4 text-[34px] text-forest sm:text-[42px]">What leaked?</h2>
    </div>
  );
}

const EXAMPLES = [
  { label: "Scan a repo", text: "Scan github.com/octocat/Hello-World for leaked keys." },
  { label: "Check pasted config", text: "Is anything sensitive in this?\n\nDATABASE_URL=postgres://app:Pa55w0rd-9f8e7d6c@db.internal:5432/app\nGITHUB_TOKEN=ghp_" + "Z8kQ2mN4pR7sT1vX3yB5cD6fG9hJ0kL2mN4p" },
  { label: "Rotate a key", text: "My Stripe live key leaked in a public repo. What do I do, in order?" },
  { label: "Check a package", text: "Does lodash 4.17.15 have known vulnerabilities?" },
];

interface ComposerProps {
  model: string;
  running: boolean;
  awaiting: boolean;
  fullAccess: boolean;
  onToggleAccess: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  ref: React.Ref<HTMLTextAreaElement>;
}

function Composer({ model, running, awaiting, fullAccess, onToggleAccess, onSend, onStop, ref }: ComposerProps) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement | null>(null);
  const resize = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  };
  useEffect(resize, [text]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void onSend(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const placeholder = awaiting ? "Reply to decline and redirect the agent" : "Paste code, a repo, or a leak notice…";
  return (
    <div className="pointer-events-auto mx-auto w-full max-w-[46rem]">
      <form
        onSubmit={(e) => (e.preventDefault(), submit())}
        className="rounded-2xl border border-line bg-white/90 shadow-[0_1px_2px_rgb(0_0_0/5%),0_8px_24px_-12px_rgb(20_30_25/18%)] backdrop-blur focus-within:border-pine/30"
      >
        <label htmlFor="composer" className="sr-only">Message</label>
        <textarea
          id="composer"
          ref={(el) => {
            area.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = el;
          }}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          className="block max-h-52 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Tip label="Keys you paste are swapped for placeholders before the model sees them. Tools use the real values on the server.">
            <span tabIndex={0} aria-label="Pasted keys are hidden from the model" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted">
              <KeyRound className="size-3.5" aria-hidden />
              <span className="max-sm:hidden">Keys hidden</span>
            </span>
          </Tip>
          <Tip label={fullAccess ? "Full access: everything the agent asks for is approved, even with this page closed. Click to ask first again." : "Approve everything the agent asks for without stopping, even with this page closed."}>
            <button type="button" aria-pressed={fullAccess} onClick={onToggleAccess} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors", fullAccess ? "bg-tan/[0.12] text-tan" : "text-muted hover:text-ink")}>
              <Zap className={cn("size-3.5", fullAccess && "fill-current")} aria-hidden />
              <span className="max-sm:hidden">Full access</span>
            </button>
          </Tip>
          <span className="flex-1" />
          <span className="flex h-7 items-center gap-1 px-2 font-mono text-[11px] text-faint">
            <Sparkles className="size-3.5" aria-hidden />
            {model}
          </span>
          {running && !text.trim() ? (
            <Tip label={<>Stop <Kbd className="ml-1 border-white/20 bg-white/10 text-white/80">Esc</Kbd></>}>
              <button type="button" onClick={onStop} aria-label="Stop" className="grid size-8 place-items-center rounded-full bg-rust/90 text-white transition-transform hover:scale-105">
                <Square className="size-3 fill-current" aria-hidden />
              </button>
            </Tip>
          ) : (
            <Tip label={<>Send <Kbd className="ml-1 border-white/20 bg-white/10 text-white/80">↵</Kbd></>}>
              <button type="submit" disabled={!text.trim()} aria-label="Send" className="grid size-8 place-items-center rounded-full bg-pine text-white shadow-xs transition-transform hover:scale-105 disabled:bg-ink/10 disabled:text-white disabled:hover:scale-100">
                <ArrowUp className="size-4" strokeWidth={2} aria-hidden />
              </button>
            </Tip>
          )}
        </div>
      </form>
      {!text && <Examples onPick={(t) => (setText(t), area.current?.focus())} hidden={running} />}
    </div>
  );
}

function Examples({ onPick, hidden }: { onPick: (text: string) => void; hidden: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(location.hash === ""), []);
  if (!show || hidden || location.hash) return null;
  return (
    <div className="mt-3 flex flex-wrap justify-center gap-1.5">
      {EXAMPLES.map((e) => (
        <button key={e.label} type="button" onClick={() => onPick(e.text)} className="h-8 rounded-full border border-line bg-white px-3 text-[12.5px] text-ink-soft transition-colors hover:border-pine/30 hover:text-ink">
          {e.label}
        </button>
      ))}
    </div>
  );
}

function Timeline({ messages, pending, session, running, sending, error, empty }: { messages: Message[]; pending: PermissionRequest[]; session?: string; running?: number; sending?: string; error: string; empty: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const turns = useMemo(() => group(messages), [messages]);
  if (empty) return <div className="flex-1" />;
  return (
    <div ref={scroller} onScroll={(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80)} className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[46rem] px-3 pb-44 pt-4 sm:px-12 sm:box-content">
        {turns.map((t, i) => (
          <Turn key={t.user?.id ?? i} turn={t} live={i === turns.length - 1 ? running : undefined} pending={i === turns.length - 1 ? pending : []} session={session} />
        ))}
        {sending && (
          <div className="flex flex-col items-end pb-4">
            <div className="shimmer max-w-[80%] rounded-2xl bg-cream px-3.5 py-2.5 text-[14px]">Hiding any keys…</div>
          </div>
        )}
        {error && <p role="alert" className="mt-1 rounded-lg bg-rust/5 px-3 py-2 text-[13px] text-rust">{error}</p>}
      </div>
    </div>
  );
}

interface TurnData {
  user?: Extract<Message, { type: "user" }>;
  replies: Array<Extract<Message, { type: "assistant" }>>;
}

function group(messages: Message[]): TurnData[] {
  const turns: TurnData[] = [];
  for (const m of messages) {
    if (m.type === "user") turns.push({ user: m, replies: [] });
    else if (m.type === "assistant") (turns.at(-1) ?? (turns.push({ replies: [] }), turns.at(-1)!)).replies.push(m);
  }
  return turns;
}

function Turn({ turn, live, pending, session }: { turn: TurnData; live?: number; pending: PermissionRequest[]; session?: string }) {
  const parts: AssistantPart[] = turn.replies.flatMap((r) => r.content);
  const tools = parts.filter((p): p is ToolPart => p.type === "tool");
  const texts = parts.filter((p): p is Extract<AssistantPart, { type: "text" }> => p.type === "text" && Boolean(p.text.trim()));
  const thinking = parts.some((p) => p.type === "reasoning") && !texts.length;
  const started = turn.replies[0]?.time.created ?? turn.user?.time.created;
  const ended = turn.replies.at(-1)?.time.completed;
  const [open, setOpen] = useState(false);
  const showTools = live !== undefined || open || pending.length > 0;
  return (
    <div className="pb-4">
      {turn.user && (
        <div className="flex flex-col items-end gap-1 pb-3">
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-cream px-3.5 py-2.5 text-[14px] leading-relaxed">{withSecrets(turn.user.text)}</div>
        </div>
      )}
      {tools.length > 0 && live === undefined && started && ended && (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mb-1 flex h-7 w-full items-center gap-1.5 border-b border-line-soft text-[12.5px] text-faint hover:text-ink-soft">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          Worked for {duration(ended - started)} · {tools.length === 1 ? "1 check" : `${tools.length} checks`}
        </button>
      )}
      {showTools && tools.map((p) => <ToolRow key={p.id} part={p} />)}
      {pending.map((p) => session && <Held key={p.id} request={p} session={session} />)}
      {live !== undefined && !texts.length && !pending.length && (
        <div className="flex h-7 items-center gap-1.5 text-[13px]">
          <span className="grid size-6 place-items-center"><span className="size-1.5 animate-pulse rounded-full bg-pine" /></span>
          <span className="shimmer">{thinking ? "Thinking" : "Working"}</span>
          <span className="font-mono text-[11.5px] tabular-nums text-faint"><Elapsed since={live} /></span>
        </div>
      )}
      {texts.length > 0 && (
        <div className="px-1 pt-1 text-[14px] leading-relaxed text-ink/90">
          <Markdown text={texts.map((t) => t.text).join("\n\n")} />
        </div>
      )}
    </div>
  );
}

/** A tool call opencode is holding until the user decides: why, then the three choices. */
function Held({ request, session }: { request: PermissionRequest; session: string }) {
  const [busy, setBusy] = useState(false);
  const reply = async (decision: "once" | "always" | "reject") => {
    setBusy(true);
    await api.reply(session, request.id, decision).catch(() => setBusy(false));
  };
  const why = request.metadata?.reason ?? `${request.action} on ${request.resources.join(", ")}`;
  return (
    <div role="group" aria-label="Approval needed" className="my-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-tan/30 bg-tan/[0.07] px-3 py-2.5 text-[13px]">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-tan">Held</span>
        <span className="min-w-0 text-ink-soft">{why}</span>
      </span>
      <span className="flex items-center gap-1">
        <button type="button" disabled={busy} onClick={() => reply("reject")} className="h-7 rounded-full px-3 text-[12.5px] font-medium text-ink-soft hover:bg-white disabled:opacity-50">Keep blocked</button>
        <Tip label="Allow this repo without asking again on this server">
          <button type="button" disabled={busy} onClick={() => reply("always")} className="h-7 rounded-full border border-line bg-white px-3 text-[12.5px] font-medium text-ink hover:border-pine/30 disabled:opacity-50">Always allow</button>
        </Tip>
        <button type="button" disabled={busy} onClick={() => reply("once")} autoFocus className="h-7 rounded-full bg-pine px-3 text-[12.5px] font-medium text-white hover:bg-pine-deep disabled:opacity-50">Allow once</button>
      </span>
    </div>
  );
}

/** Folds one live event into the current session's messages. */
function apply(messages: Message[], ev: OcEvent): Message[] {
  const d = ev.data as Record<string, unknown> & { assistantMessageID?: string; id?: string };
  const assistant = (id: string, m: Message[]): [Message[], Extract<Message, { type: "assistant" }>] => {
    let a = m.find((x): x is Extract<Message, { type: "assistant" }> => x.id === id && x.type === "assistant");
    if (!a) {
      a = { id, type: "assistant", content: [], time: { created: Date.now() } };
      return [[...m, a], a];
    }
    const copy = { ...a, content: [...a.content] };
    return [m.map((x) => (x.id === id ? copy : x)), copy];
  };
  switch (ev.type) {
    case "session.inbox.enqueued": {
      const item = d.item as { type?: string; payload?: { text?: string } } | undefined;
      const id = String(d.inboxID);
      if (item?.type !== "user" || messages.some((m) => m.id === id)) return messages;
      return [...messages, { id, type: "user", text: item.payload?.text ?? "", time: { created: Date.now() } }];
    }
    case "session.step.started":
      return assistant(String(d.assistantMessageID), messages)[0];
    case "session.text.delta": {
      const [m, a] = assistant(String(d.assistantMessageID), messages);
      const last = a.content.at(-1);
      if (last?.type === "text") a.content[a.content.length - 1] = { type: "text", text: last.text + String(d.delta ?? "") };
      else a.content.push({ type: "text", text: String(d.delta ?? "") });
      return m;
    }
    case "session.reasoning.started": {
      const [m, a] = assistant(String(d.assistantMessageID), messages);
      a.content.push({ type: "reasoning" });
      return m;
    }
    case "session.tool.input.started": {
      const [m, a] = assistant(String(d.assistantMessageID), messages);
      a.content.push({ type: "tool", id: String(d.id), name: String(d.name), state: { status: "pending" } });
      return m;
    }
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const [m, a] = assistant(String(d.assistantMessageID), messages);
      const i = a.content.findIndex((p) => p.type === "tool" && p.id === d.id);
      const prev = (i >= 0 ? a.content[i] : { type: "tool", id: String(d.id), name: "tool", state: { status: "pending" } }) as ToolPart;
      const state: ToolPart["state"] =
        ev.type === "session.tool.called"
          ? { ...prev.state, status: "running", input: d.input }
          : ev.type === "session.tool.success"
            ? { ...prev.state, status: "completed", content: d.content as ToolPart["state"]["content"] }
            : { ...prev.state, status: "error", error: d.error as ToolPart["state"]["error"] };
      const next = { ...prev, state };
      if (i >= 0) a.content[i] = next;
      else a.content.push(next);
      return m;
    }
    default:
      return messages;
  }
}
