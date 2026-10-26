import path from "node:path";
import { writeJson } from "../core/fs.ts";
import { configDir } from "../store.ts";
import { describeTarget, type Driver, type Target } from "./driver.ts";

// Deterministic flows. Every step states what "done" looks like, so the runner can:
//   - skip steps that are already done (re-running a flow resumes instead of repeating work),
//   - retry a step a fixed number of times, with a fixed timeout, then stop,
//   - classify every failure into one of a few kinds with a fixed exit code,
//   - save a screenshot, URL and step log for each failure,
//   - hand a step to the person at the keyboard when the flow says it may, then carry on,
//   - tell "the site changed" apart from "you're signed out" using the flow's signed-in check,
//     and record site changes so the flow gets fixed (see drift.ts).
// The same inputs and the same page state always produce the same sequence of actions and outcome.

export type FailureKind = "timeout" | "missing" | "unexpected-page" | "needs-human" | "driver" | "site-changed" | "signed-out";

export const EXIT_CODES: Readonly<Record<FailureKind, number>> = {
  timeout: 20,
  missing: 21,
  "unexpected-page": 22,
  "needs-human": 23,
  driver: 24,
  "site-changed": 25,
  "signed-out": 26,
};

export class FlowError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly step: string,
    message: string,
    readonly artifacts?: string,
  ) {
    super(`[${kind}] ${step}: ${message}${artifacts ? ` (details: ${artifacts})` : ""}`);
  }
  get exitCode() {
    return EXIT_CODES[this.kind];
  }
}

export interface Step<S> {
  readonly id: string;
  readonly description: string;
  /** Postcondition: true once this step's effect is visible. Checked before running (to skip) and after. */
  done(driver: Driver, state: S): Promise<boolean>;
  run(driver: Driver, state: S): Promise<void>;
  /** How long to wait for `done` after each attempt. */
  readonly timeoutMs: number;
  /** Extra attempts after the first (0 = run once). */
  readonly retries: number;
  /** When attempts run out: stop, or ask the person to finish this step in the window. */
  readonly onExhausted: "abort" | "handoff";
}

export interface StepRecord {
  id: string;
  status: "skipped" | "done" | "done-by-human" | "failed";
  attempts: number;
  ms: number;
  failure?: FailureKind;
}

export interface FlowOptions {
  readonly name: string;
  readonly log: (message: string) => void;
  /** How long to wait for a person to finish a handed-off step. */
  readonly handoffMs?: number;
  readonly pollMs?: number;
  /** Clock and sleep are injectable so tests run instantly and identically. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly artifactsDir?: string;
  /**
   * True while the provider shows a signed-in page (e.g. the account menu is there). Lets a step
   * that can't find its element be reported as a site change rather than a lost session.
   */
  readonly signedIn?: (driver: Driver) => Promise<boolean>;
  /** Records a site change. Defaults to the local drift log; tests pass their own. */
  readonly onDrift?: (d: { flow: string; step: string; url: string; message: string }) => Promise<unknown>;
}

/** The page's own output didn't have the expected shape (e.g. no key in the dialog): the site changed. */
export function expectOutput(value: string | undefined, pattern: RegExp, step: string): string {
  if (value === undefined || !pattern.test(value)) throw new FlowError("site-changed", step, `the page no longer shows what this step reads (expected ${pattern})`);
  return value;
}

export async function runFlow<S>(driver: Driver, steps: readonly Step<S>[], state: S, opts: FlowOptions): Promise<StepRecord[]> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const poll = opts.pollMs ?? 500;
  const records: StepRecord[] = [];
  const runId = `${opts.name}-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
  const dir = opts.artifactsDir ?? path.join(configDir(), "runs", runId);

  const waitDone = async (step: Step<S>, ms: number) => {
    const end = now() + ms;
    for (;;) {
      if (await step.done(driver, state)) return true;
      if (now() >= end) return false;
      await sleep(poll);
    }
  };

  const fail = async (step: Step<S>, kind: FailureKind, message: string): Promise<never> => {
    let artifacts: string | undefined;
    try {
      await Bun.write(path.join(dir, `${step.id}.png`), await driver.screenshot());
      await writeJson(path.join(dir, "run.json"), { flow: opts.name, url: await driver.url(), failedStep: step.id, kind, message, steps: records });
      artifacts = dir;
    } catch {
      /* the failure itself is what matters; artifacts are best effort */
    }
    throw new FlowError(kind, step.id, message, artifacts);
  };

  for (const step of steps) {
    const started = now();
    const record: StepRecord = { id: step.id, status: "failed", attempts: 0, ms: 0 };
    records.push(record);

    if (await step.done(driver, state)) {
      Object.assign(record, { status: "skipped", ms: now() - started });
      opts.log(`  ✓ ${step.description} (already done)`);
      continue;
    }

    let lastKind: FailureKind = "timeout";
    let lastMessage = "";
    for (let attempt = 0; attempt <= step.retries; attempt++) {
      record.attempts = attempt + 1;
      opts.log(`  … ${step.description}${attempt ? ` (attempt ${attempt + 1}/${step.retries + 1})` : ""}`);
      try {
        await step.run(driver, state);
        if (await waitDone(step, step.timeoutMs)) {
          Object.assign(record, { status: "done", ms: now() - started });
          break;
        }
        [lastKind, lastMessage] = ["timeout", `not done after ${step.timeoutMs}ms`];
      } catch (error) {
        if (error instanceof FlowError) [lastKind, lastMessage] = [error.kind, error.message];
        else [lastKind, lastMessage] = ["driver", error instanceof Error ? error.message : String(error)];
      }
    }
    if (record.status === "done") continue;

    if (step.onExhausted === "handoff") {
      opts.log(`  ⇢ ${step.description}: finish this step in the browser window; Sikrets continues when it's done`);
      if (await waitDone(step, opts.handoffMs ?? 5 * 60_000)) {
        Object.assign(record, { status: "done-by-human", ms: now() - started });
        continue;
      }
      record.failure = "needs-human";
      await fail(step, "needs-human", `handed off after: ${lastMessage}`);
    }
    // A missing element or a wrong page means the site changed if we're still signed in, and a
    // lost session if we aren't. Without a signed-in check, the failure keeps its own kind.
    if (opts.signedIn && (lastKind === "missing" || lastKind === "unexpected-page" || lastKind === "timeout")) {
      lastKind = (await opts.signedIn(driver).catch(() => true)) ? "site-changed" : "signed-out";
    }
    if (lastKind === "site-changed") {
      const onDrift = opts.onDrift ?? (async (d) => (await import("./drift.ts")).recordDrift(d));
      await onDrift({ flow: opts.name, step: step.id, url: await driver.url().catch(() => ""), message: lastMessage }).catch(() => {});
    }
    record.failure = lastKind;
    await fail(step, lastKind, lastMessage);
  }
  return records;
}

// Step helpers for the common shapes, so flows read as a list of intentions.

/** Fails with "missing" (not a generic timeout) when the element never appears. */
export async function waitFor(driver: Driver, target: Target, step: string, timeoutMs: number, opts: Pick<FlowOptions, "now" | "sleep"> = {}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const end = now() + timeoutMs;
  for (;;) {
    const box = await driver.find(target);
    if (box) return box;
    if (now() >= end) throw new FlowError("missing", step, `${describeTarget(target)} never appeared within ${timeoutMs}ms`);
    await sleep(250);
  }
}

export async function expectUrl(driver: Driver, pattern: RegExp, step: string) {
  const url = await driver.url();
  if (!pattern.test(url)) throw new FlowError("unexpected-page", step, `expected ${pattern}, got ${new URL(url).origin}${new URL(url).pathname}`);
}
