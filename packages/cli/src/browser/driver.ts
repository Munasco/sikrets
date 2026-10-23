// The one browser surface flows are written against. Implementations: obu (drives your real Chrome
// profiles through the Open Browser Use extension), and later the Sikrets extension, which will
// speak the same protocol shape. Flows never import an implementation directly.

/** How a flow points at an element: a CSS selector, or a role plus its visible/accessible name. */
export type Target =
  | { readonly css: string }
  | { readonly role: "button" | "link" | "textbox" | "dialog"; readonly name: string | RegExp };

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Driver {
  readonly kind: "obu" | "extension";
  goto(url: string): Promise<void>;
  url(): Promise<string>;
  /** Visible bounding box of the first match, or null. Never throws for "not found". */
  find(target: Target): Promise<Box | null>;
  click(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
  /** Visible text of the target (or the whole page). */
  text(target?: Target): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export const describeTarget = (t: Target) => ("css" in t ? t.css : `${t.role} "${String(t.name)}"`);
