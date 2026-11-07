import type { ImportPreview, ManagerId } from "../api.ts";

// The Import screen's one record: idle → previewing → previewed → importing → idle, or failed.
// The source and prefix are frozen from the preview on. A preview answer that arrives after a
// newer preview started (an older seq) is dropped.

export type Source = { kind: "file"; path: string } | { kind: "manager"; id: ManagerId };
export type Frozen = { source: Source; prefix: string };

export type Wizard =
  | { phase: "idle" }
  | ({ phase: "previewing"; seq: number } & Frozen)
  | ({ phase: "previewed"; preview: ImportPreview } & Frozen)
  | ({ phase: "importing"; preview: ImportPreview } & Frozen)
  | ({ phase: "failed"; error: unknown; preview?: ImportPreview } & Partial<Frozen>);

export type Event =
  | ({ type: "preview"; seq: number } & Frozen)
  | { type: "previewed"; seq: number; preview: ImportPreview }
  | { type: "previewFailed"; seq: number; error: unknown }
  | { type: "import" }
  | { type: "imported" }
  | { type: "importFailed"; error: unknown }
  | { type: "cancel" };

/** The one place the wizard moves. Anything else (a stale answer, a click mid-import) is ignored. */
export function step(w: Wizard, e: Event): Wizard {
  switch (e.type) {
    case "preview":
      return w.phase === "importing" ? w : { phase: "previewing", seq: e.seq, source: e.source, prefix: e.prefix };
    case "previewed":
      return w.phase === "previewing" && w.seq === e.seq ? { phase: "previewed", source: w.source, prefix: w.prefix, preview: e.preview } : w;
    case "previewFailed":
      return w.phase === "previewing" && w.seq === e.seq ? { phase: "failed", source: w.source, prefix: w.prefix, error: e.error } : w;
    case "import":
      return w.phase === "previewed" ? { ...w, phase: "importing" } : w;
    case "imported":
      return w.phase === "importing" ? { phase: "idle" } : w;
    case "importFailed":
      // Keep the preview on screen; a changed source needs a fresh preview before it can import.
      return w.phase === "importing" ? { phase: "failed", source: w.source, prefix: w.prefix, preview: w.preview, error: e.error } : w;
    case "cancel":
      return w.phase === "importing" ? w : { phase: "idle" };
  }
}

