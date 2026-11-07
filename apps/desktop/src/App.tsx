import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { Bot, FolderOpen, Download, KeyRound, MessageSquare, RefreshCw, Settings as SettingsIcon, ShieldCheck, Globe } from "lucide-react";
import { chooseProject, info as loadInfo, inTauri, needsAnswer, onNavigate, setPending, sikrets, type Approval, type Info } from "./api.ts";
import { Button, cn, ErrorLine, IconButton, Kbd, Logo, message, RefreshCtx, Tip, Toasts, useToast } from "./ui.tsx";
import { Keys } from "./screens/Keys.tsx";
import { Approvals } from "./screens/Approvals.tsx";
import { Agents } from "./screens/Agents.tsx";
import { Logins } from "./screens/Logins.tsx";
import { Import } from "./screens/Import.tsx";
import { AgentChat } from "./screens/AgentChat.tsx";
import { Settings } from "./screens/Settings.tsx";

export type Route = "keys" | "approvals" | "agents" | "logins" | "import" | "agent" | "settings";

const NAV: { id: Route; label: string; icon: ReactNode }[] = [
  { id: "keys", label: "Keys", icon: <KeyRound className="size-4" /> },
  { id: "approvals", label: "Approvals", icon: <ShieldCheck className="size-4" /> },
  { id: "agents", label: "Agents", icon: <Bot className="size-4" /> },
  { id: "logins", label: "Logins", icon: <Globe className="size-4" /> },
  { id: "import", label: "Import", icon: <Download className="size-4" /> },
  { id: "agent", label: "Guard", icon: <MessageSquare className="size-4" /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon className="size-4" /> },
];

const PENDING_POLL_MS = 15_000;

/**
 * What the window can show, from the Rust side's `info`: still asking, couldn't ask, no project
 * chosen, a folder without sikrets.json, or a project the screens can work in.
 */
type Gate =
  | { status: "loading"; last?: Info }
  | { status: "error"; error: unknown; last?: Info }
  | { status: "noProject"; info: Info }
  | { status: "uninitialized"; info: Info }
  | { status: "ready"; info: Info };

type GateEvent = { type: "load" } | { type: "loaded"; info: Info } | { type: "failed"; error: unknown };

const lastInfo = (g: Gate) => ("info" in g ? g.info : g.last);

function gate(g: Gate, e: GateEvent): Gate {
  switch (e.type) {
    case "load":
      return { status: "loading", last: lastInfo(g) };
    case "failed":
      return { status: "error", error: e.error, last: lastInfo(g) };
    case "loaded":
      return !e.info.project ? { status: "noProject", info: e.info } : !e.info.initialized ? { status: "uninitialized", info: e.info } : { status: "ready", info: e.info };
  }
}

/** Screens that work without a set-up project. */
const ALWAYS: Route[] = ["settings", "agent"];

function initialRoute(): Route {
  const hash = location.hash.slice(1) as Route;
  return NAV.some((n) => n.id === hash) ? hash : "keys";
}

export function App() {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [tick, setTick] = useState(0);
  const [g, dispatch] = useReducer(gate, { status: "loading" });
  const info = lastInfo(g);
  const [pending, setPendingCount] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const go = useCallback((r: Route) => {
    setRoute(r);
    history.replaceState(null, "", `#${r}`);
  }, []);

  useEffect(() => {
    let current = true;
    dispatch({ type: "load" });
    loadInfo().then(
      (i) => current && dispatch({ type: "loaded", info: i }),
      (error) => current && dispatch({ type: "failed", error }),
    );
    return () => {
      current = false;
    };
  }, [tick]);

  // The menu bar asks for a screen (Keys, Approvals) through a "navigate" event.
  useEffect(() => onNavigate((r) => go(r as Route)), [go]);

  // Requests waiting for a person (pending, or failed and retryable): badge here and a count
  // beside the menu-bar icon. An answer for a project that's no longer open is dropped; a failed
  // poll clears the count rather than keep an old one.
  const project = g.status === "ready" ? g.info.project : null;
  useEffect(() => {
    let current = true;
    const show = (n: number) => {
      if (!current) return;
      setPendingCount(n);
      void setPending(n);
    };
    if (!project) return show(0), () => void (current = false);
    const poll = () => sikrets<Approval[]>(["approvals", "list"]).then((all) => show(all.filter(needsAnswer).length), () => show(0));
    void poll();
    const id = setInterval(poll, PENDING_POLL_MS);
    return () => {
      current = false;
      clearInterval(id);
    };
  }, [project, tick]);

  // ⌘1–7 switch screens, ⌘R reloads.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault();
        go(NAV[n - 1]!.id);
      } else if (e.key === "r") {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, refresh]);

  const projectName = info?.project?.split("/").filter(Boolean).at(-1);
  const current = NAV.find((n) => n.id === route)!;
  const ctx = useMemo(() => ({ tick, refresh }), [tick, refresh]);

  return (
    <RefreshCtx.Provider value={ctx}>
      <Toasts>
        <div className="flex h-full">
          <aside className="flex w-[200px] shrink-0 flex-col border-r border-line bg-cream/70">
            <div className="drag h-11 shrink-0" />
            <div className="flex items-center gap-2 px-4 pb-4">
              <Logo className="size-[18px] text-forest" />
              <span className="text-[14px] font-semibold tracking-tight text-forest">Sikrets</span>
            </div>
            <nav className="flex flex-col gap-px px-2" aria-label="Screens">
              {NAV.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => go(n.id)}
                  aria-current={route === n.id ? "page" : undefined}
                  className={cn(
                    "group flex h-7 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors",
                    route === n.id ? "bg-white text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-soft hover:bg-white/60 hover:text-ink",
                  )}
                >
                  <span className={cn(route === n.id ? "text-pine" : "text-dim group-hover:text-ink-soft")}>{n.icon}</span>
                  <span className="flex-1">{n.label}</span>
                  {n.id === "approvals" && pending > 0 ? (
                    <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-forest px-1 font-mono text-[10px] text-cream">{pending}</span>
                  ) : (
                    <Kbd className="opacity-0 transition-opacity group-hover:opacity-100">⌘{i + 1}</Kbd>
                  )}
                </button>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-2 p-3">
              {!inTauri && <span className="label px-1 text-[9.5px]">Preview · demo data</span>}
              <Tip label={info?.project ?? "Choose the folder with sikrets.json"} side="top" className="w-full">
                <ChooseButton
                  onChosen={refresh}
                  className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-white px-2 text-left text-[12.5px] hover:bg-paper"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-dim" />
                  <span className="truncate">{projectName ?? "Choose project"}</span>
                </ChooseButton>
              </Tip>
            </div>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col bg-paper">
            <header className="drag flex h-11 shrink-0 items-center justify-between border-b border-line px-5">
              <h1 className="text-[13px] font-semibold">{current.label}</h1>
              <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
                <IconButton label="Reload" shortcut="⌘R" side="left" onClick={refresh}>
                  <RefreshCw className="size-3.5" />
                </IconButton>
              </div>
            </header>
            <div className={cn("scroll-thin min-h-0 flex-1", route === "agent" ? "overflow-hidden" : "overflow-y-auto")}>
              <Body gate={g} route={route} go={go} onRetry={refresh} />
            </div>
          </main>
        </div>
      </Toasts>
    </RefreshCtx.Provider>
  );
}

function Body({ gate: g, route, go, onRetry }: { gate: Gate; route: Route; go: (r: Route) => void; onRetry: () => void }) {
  const info = lastInfo(g);
  if (g.status === "error" && !info) return <InfoError error={g.error} onRetry={onRetry} />;
  if (!info) return null; // first load, a moment
  if (g.status === "noProject" && !ALWAYS.includes(route)) return <NoProject onChosen={onRetry} />;
  if (g.status === "uninitialized" && !ALWAYS.includes(route)) return <SetUp go={go} />;
  // Keyed by project: switching projects starts every screen afresh (no half-done import carries over).
  return (
    <>
      {g.status === "error" && (
        <div className="px-5 pt-4">
          <ErrorLine error={g.error} />
        </div>
      )}
      {info.settingsError && (
        <div className="px-5 pt-4">
          <ErrorLine error={`Couldn't read the app's settings (${info.settingsError}). Choose the project again.`} />
        </div>
      )}
      <Screen key={info.project ?? ""} route={route} info={info} go={go} />
    </>
  );
}

/** Picks a folder; a folder that couldn't be saved as the project is reported, not ignored. */
function ChooseButton({ onChosen, className, children }: { onChosen: () => void; className: string; children: ReactNode }) {
  const toast = useToast();
  return (
    <button type="button" className={className} onClick={() => chooseProject().then((p) => p && onChosen(), (e) => toast(`Couldn't switch project: ${message(e)}`, "bad"))}>
      {children}
    </button>
  );
}

function InfoError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-[14px] font-medium">Couldn't load the project</p>
        <ErrorLine error={error} />
        <Button variant="primary" onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}

function SetUp({ go }: { go: (r: Route) => void }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Logo className="size-8 text-forest" />
        <p className="text-[14px] font-medium">This folder isn't set up yet</p>
        <p className="text-[12.5px] text-dim">There's no sikrets.json here.</p>
        <Button variant="primary" onClick={() => go("settings")}>Set up in Settings</Button>
      </div>
    </div>
  );
}

function Screen({ route, info, go }: { route: Route; info: Info; go: (r: Route) => void }) {
  switch (route) {
    case "keys":
      return <Keys go={go} />;
    case "approvals":
      return <Approvals />;
    case "agents":
      return <Agents />;
    case "logins":
      return <Logins />;
    case "import":
      return <Import />;
    case "agent":
      return <AgentChat />;
    case "settings":
      return <Settings info={info} />;
  }
}

function NoProject({ onChosen }: { onChosen: () => void }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Logo className="size-8 text-forest" />
        <p className="text-[14px] font-medium">Choose a project</p>
        <p className="text-[12.5px] text-dim">The folder with sikrets.json, or any folder to start one.</p>
        <ChooseButton onChosen={onChosen} className="mt-1 inline-flex h-8 items-center gap-2 rounded-md bg-forest px-3 text-[12.5px] font-medium text-cream hover:bg-pine">
          <FolderOpen className="size-3.5" /> Choose folder
        </ChooseButton>
      </div>
    </div>
  );
}
