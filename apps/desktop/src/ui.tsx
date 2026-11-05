import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { copyText } from "./api.ts";

// Shared pieces: the logo, tooltips, buttons, chips, form fields, toasts and a small data hook.

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

/** The Sikrets mark: an arch with a keyhole. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M4 22V10.5a8 8 0 0 1 16 0V22zM12 9.2a2.2 2.2 0 0 0-1.1 4.1L10.4 18h3.2l-.5-4.7A2.2 2.2 0 0 0 12 9.2z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** A tooltip on hover and keyboard focus. */
export function Tip({ label, children, side = "top", className }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "right" | "left"; className?: string }) {
  const pos = {
    top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
    bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
    right: "left-full top-1/2 ml-2 -translate-y-1/2",
    left: "right-full top-1/2 mr-2 -translate-y-1/2",
  }[side];
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span role="tooltip" className={cn("pointer-events-none absolute z-50 w-max max-w-[260px] rounded-md bg-ink px-2 py-1 text-[11.5px] leading-snug text-white opacity-0 shadow-lg transition-opacity delay-200 group-focus-within/tip:opacity-100 group-hover/tip:opacity-100", pos)}>
        {label}
      </span>
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-[17px] min-w-[17px] items-center justify-center rounded border border-line bg-white px-1 font-mono text-[10px] leading-none text-dim", className)}>{children}</kbd>;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; side?: "top" | "bottom" | "right" | "left"; busy?: boolean };

export function IconButton({ label, shortcut, children, className, side, busy, disabled, ...rest }: IconButtonProps) {
  return (
    <Tip label={<>{label}{shortcut && <Kbd className="ml-1.5 border-white/20 bg-white/10 text-white/80">{shortcut}</Kbd>}</>} side={side}>
      <button type="button" aria-label={label} disabled={disabled || busy} className={cn("grid size-7 place-items-center rounded-md text-dim transition-colors hover:bg-sand hover:text-ink disabled:pointer-events-none disabled:opacity-40", className)} {...rest}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : children}
      </button>
    </Tip>
  );
}

export function Button({ variant = "quiet", busy, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" | "danger"; busy?: boolean }) {
  const look = {
    primary: "bg-forest text-cream hover:bg-pine border-forest",
    quiet: "bg-lift text-ink hover:bg-lift-hover border-line",
    danger: "bg-white text-rust hover:bg-rust/5 border-rust/30",
  }[variant];
  return (
    <button type="button" disabled={disabled || busy} className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none", look, className)} {...rest}>
      {busy && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Chip({ tone = "plain", children, className }: { tone?: "plain" | "good" | "warn" | "bad" | "info"; children: ReactNode; className?: string }) {
  const look = {
    plain: "bg-cream text-ink-soft border-line",
    good: "bg-pine/[0.07] text-pine border-pine/15",
    warn: "bg-amber/[0.08] text-amber border-amber/20",
    bad: "bg-rust/[0.07] text-rust border-rust/20",
    info: "bg-white text-dim border-line",
  }[tone];
  return <span className={cn("inline-flex h-[19px] items-center gap-1 rounded border px-1.5 font-mono text-[10.5px] leading-none whitespace-nowrap", look, className)}>{children}</span>;
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input spellCheck={false} autoComplete="off" className={cn("h-7 w-full rounded-md border border-line bg-white px-2 text-[12.5px] text-ink placeholder:text-muted focus:border-pine/40 focus:outline-none", className)} {...rest} />;
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function CopyButton({ text, label = "Copy", className, side }: { text: string; label?: string; className?: string; side?: "top" | "bottom" | "right" | "left" }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? "Copied" : label}
      className={className}
      side={side}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="size-3.5 text-pine" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

/** A command or snippet with a copy button. Long paths wrap instead of scrolling. */
export function Snippet({ text, label }: { text: string; label?: string }) {
  return (
    <div className="group flex items-start gap-2 rounded-md bg-well py-1 pr-1 pl-3 ring-1 ring-line/60 ring-inset">
      <pre className="selectable min-w-0 flex-1 py-[5px] font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap text-ink [overflow-wrap:break-word]">{text}</pre>
      <CopyButton text={text} label={label ?? "Copy"} />
    </div>
  );
}

/** A row of mutually exclusive choices: tabs or a radio group, with arrow-key movement. */
export function Segmented<T extends string>({ value, options, onChange, role = "radiogroup", label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; role?: "tablist" | "radiogroup"; label: string }) {
  const item = role === "tablist" ? "tab" : "radio";
  const ref = useRef<HTMLDivElement>(null);
  const move = (by: number) => {
    const i = (options.findIndex(([id]) => id === value) + by + options.length) % options.length;
    onChange(options[i]![0]);
    ref.current?.querySelectorAll<HTMLButtonElement>("button")[i]?.focus();
  };
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      onKeyDown={(e) => {
        const by = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
        if (by) {
          e.preventDefault();
          move(by);
        }
      }}
      className="inline-grid h-7 auto-cols-fr grid-flow-col gap-0.5 self-start rounded-md bg-well p-0.5 text-[12px] ring-1 ring-line ring-inset"
    >
      {options.map(([id, text]) => {
        const on = value === id;
        return (
          <button
            key={id}
            type="button"
            role={item}
            tabIndex={on ? 0 : -1}
            {...(item === "tab" ? { "aria-selected": on } : { "aria-checked": on })}
            onClick={() => onChange(id)}
            className={cn("rounded px-3 font-medium whitespace-nowrap transition-colors", on ? "seg-on bg-lift text-ink" : "text-ink-soft hover:text-ink")}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-line bg-white", className)}>
      {(title || actions) && (
        <header className="flex h-9 items-center justify-between gap-2 border-b border-line px-3">
          <h2 className="label">{title}</h2>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="grid size-9 place-items-center rounded-lg bg-cream text-dim">{icon}</div>
      <p className="text-[13px] font-medium">{title}</p>
      {children && <div className="text-[12px] text-dim">{children}</div>}
    </div>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="selectable rounded-md border border-rust/20 bg-rust/[0.05] px-2.5 py-1.5 text-[12px] text-rust">{error instanceof Error ? error.message : String(error)}</p>;
}

// ── Toasts ──────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; tone: "good" | "bad" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Toasts({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "good") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "bad" ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
        {items.map((t) => (
          <div key={t.id} className={cn("rise max-w-sm rounded-md px-3 py-2 text-[12.5px] shadow-lg", t.tone === "good" ? "bg-forest text-cream" : "bg-rust text-white")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Data ────────────────────────────────────────────────────────────────

/** Bumped by ⌘R and after any change, so every screen reloads. */
export const RefreshCtx = createContext<{ tick: number; refresh: () => void }>({ tick: 0, refresh: () => {} });

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const { tick } = useContext(RefreshCtx);
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => n === seq.current && setState({ data, loading: false }),
      (error) => n === seq.current && setState({ error, loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run, tick]);
  return { ...state, reload: run };
}

/** "3d", "5h", "just now"; "never" for none. */
export function ago(iso?: string | null) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (86400 * 30))}mo ago`;
}

export function until(iso?: string | null) {
  if (!iso) return "no expiry";
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return "expired";
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.ceil(s / 3600)}h`;
  return `in ${Math.ceil(s / 86400)}d`;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useRefresh = () => useContext(RefreshCtx).refresh;
