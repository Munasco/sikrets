import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Lock } from "lucide-react";

// Small shared pieces: the logo, the locked secret chip, icon buttons with tooltips, key hints.

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

/** The Sikrets mark: an arch with a keyhole. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M4 22V10.5a8 8 0 0 1 16 0V22zM12 9.2a2.2 2.2 0 0 0-1.1 4.1L10.4 18h3.2l-.5-4.7A2.2 2.2 0 0 0 12 9.2z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** A tooltip that shows on hover and keyboard focus. */
export function Tip({ label, children, side = "top", className }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "right"; className?: string }) {
  const pos = { top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2", bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2", right: "left-full top-1/2 ml-1.5 -translate-y-1/2" }[side];
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span role="tooltip" className={cn("pointer-events-none absolute z-50 w-max max-w-[260px] rounded-md bg-ink px-2 py-1 text-[11.5px] leading-snug text-white opacity-0 shadow-lg transition-opacity delay-150 group-focus-within/tip:opacity-100 group-hover/tip:opacity-100", pos)}>
        {label}
      </span>
    </span>
  );
}

/** A pasted key, as the agent saw it: locked, with only its redacted form and hash prefix. */
export function SecretChip({ redacted, hash }: { redacted: string; hash: string }) {
  return (
    <Tip label={<>Hidden from the model. Tools used the real key here, on the server; the model saw only this. <span className="font-mono opacity-70">#{hash}</span></>}>
      <span tabIndex={0} aria-label={`Hidden secret ${redacted}`} className="mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-md border border-pine/15 bg-pine/[0.07] px-1.5 py-px align-middle font-mono text-[11.5px] leading-[18px] text-pine">
        <Lock className="size-3" strokeWidth={2.25} aria-hidden />
        {redacted}
      </span>
    </Tip>
  );
}

export function IconButton({ label, shortcut, children, className, side, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; side?: "top" | "bottom" | "right" }) {
  return (
    <Tip label={<>{label}{shortcut && <Kbd className="ml-1.5 border-white/20 bg-white/10 text-white/80">{shortcut}</Kbd>}</>} side={side}>
      <button type="button" aria-label={label} className={cn("grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-sand hover:text-ink disabled:pointer-events-none disabled:opacity-40", className)} {...rest}>
        {children}
      </button>
    </Tip>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-white px-1 font-mono text-[10.5px] leading-none text-muted", className)}>{children}</kbd>;
}
