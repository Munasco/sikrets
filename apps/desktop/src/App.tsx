import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, FolderOpen, Download, KeyRound, MessageSquare, RefreshCw, Settings as SettingsIcon, ShieldCheck, Globe } from "lucide-react";
import { chooseProject, info as loadInfo, inTauri, onNavigate, setPending, sikrets, type Approval, type Info } from "./api.ts";
import { cn, IconButton, Kbd, Logo, RefreshCtx, Tip, Toasts } from "./ui.tsx";
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

function initialRoute(): Route {
  const hash = location.hash.slice(1) as Route;
  return NAV.some((n) => n.id === hash) ? hash : "keys";
}

export function App() {
  const [route, setRoute] = useState<Route>(initialRoute);
  const [tick, setTick] = useState(0);
  const [info, setInfo] = useState<Info>();
  const [pending, setPendingCount] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const go = useCallback((r: Route) => {
    setRoute(r);
    history.replaceState(null, "", `#${r}`);
  }, []);

  useEffect(() => {
    loadInfo().then(setInfo, () => {});
  }, [tick]);

  // The menu bar asks for a screen (Keys, Approvals) through a "navigate" event.
  useEffect(() => {
    let off = () => {};
    onNavigate((r) => go(r as Route)).then((f) => (off = f));
    return () => off();
  }, [go]);

  // Pending approvals: badge here and a count beside the menu-bar icon.
  useEffect(() => {
    if (!info?.project) return;
    const poll = () =>
      sikrets<Approval[]>(["approvals", "list"]).then(
        (all) => {
          const n = all.filter((a) => a.status === "pending").length;
          setPendingCount(n);
          setPending(n);
        },
        () => {},
      );
    poll();
    const id = setInterval(poll, PENDING_POLL_MS);
    return () => clearInterval(id);
  }, [info?.project, tick]);

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
                <button
                  type="button"
                  onClick={async () => (await chooseProject()) && refresh()}
                  className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-white px-2 text-left text-[12.5px] hover:bg-paper"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-dim" />
                  <span className="truncate">{projectName ?? "Choose project"}</span>
                </button>
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
              {!info ? null : !info.project && route !== "settings" && route !== "agent" ? (
                <NoProject onChosen={refresh} />
              ) : (
                <Screen route={route} info={info} go={go} />
              )}
            </div>
          </main>
        </div>
      </Toasts>
    </RefreshCtx.Provider>
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
        <button type="button" onClick={async () => (await chooseProject()) && onChosen()} className="mt-1 inline-flex h-8 items-center gap-2 rounded-md bg-forest px-3 text-[12.5px] font-medium text-cream hover:bg-pine">
          <FolderOpen className="size-3.5" /> Choose folder
        </button>
      </div>
    </div>
  );
}
