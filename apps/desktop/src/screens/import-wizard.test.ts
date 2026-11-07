import { describe, expect, test } from "bun:test";
import type { ImportPreview } from "../api.ts";
import { step, type Wizard } from "./import-wizard.ts";

const a = { kind: "file", path: "/tmp/a.env" } as const;
const b = { kind: "file", path: "/tmp/b.env" } as const;
const preview = (keys: string[]): ImportPreview => ({ source: "x", format: "dotenv", keys, replaced: [], digest: keys.join() });
const idle: Wizard = { phase: "idle" };

describe("import wizard", () => {
  test("a slower, older preview answer is dropped", () => {
    let w = step(idle, { type: "preview", seq: 1, source: a, prefix: "" });
    w = step(w, { type: "preview", seq: 2, source: b, prefix: "" });
    w = step(w, { type: "previewed", seq: 1, preview: preview(["FROM_A"]) });
    expect(w.phase).toBe("previewing");
    w = step(w, { type: "previewed", seq: 2, preview: preview(["FROM_B"]) });
    expect(w).toMatchObject({ phase: "previewed", source: b, preview: { keys: ["FROM_B"] } });
  });

  test("the prefix that imports is the one the preview used", () => {
    let w = step(idle, { type: "preview", seq: 1, source: a, prefix: "BW" });
    w = step(w, { type: "previewed", seq: 1, preview: preview(["BW_X"]) });
    w = step(w, { type: "import" });
    expect(w).toMatchObject({ phase: "importing", prefix: "BW" });
  });

  test("nothing moves it while importing: no new preview, no cancel", () => {
    let w = step(idle, { type: "preview", seq: 1, source: a, prefix: "" });
    w = step(w, { type: "previewed", seq: 1, preview: preview(["X"]) });
    w = step(w, { type: "import" });
    expect(step(w, { type: "preview", seq: 2, source: b, prefix: "" }).phase).toBe("importing");
    expect(step(w, { type: "cancel" }).phase).toBe("importing");
    expect(step(w, { type: "imported" }).phase).toBe("idle");
  });

  test("a refused import keeps the preview but can't be committed again without a new preview", () => {
    let w = step(idle, { type: "preview", seq: 1, source: a, prefix: "" });
    w = step(w, { type: "previewed", seq: 1, preview: preview(["X"]) });
    w = step(step(w, { type: "import" }), { type: "importFailed", error: new Error("changed") });
    expect(w.phase).toBe("failed");
    expect(step(w, { type: "import" }).phase).toBe("failed");
  });
});
