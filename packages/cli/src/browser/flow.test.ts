import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Driver } from "./driver.ts";
import { EXIT_CODES, FlowError, runFlow, waitFor, type Step } from "./flow.ts";

// A scripted page and a fake clock: every run of these tests sees exactly the same timeline.
function harness() {
  let t = 0;
  const page = { url: "https://console.example.com/", elements: new Set<string>() };
  const driver: Driver = {
    kind: "obu",
    goto: async (url) => void (page.url = url),
    url: async () => page.url,
    find: async (target) => ("css" in target && page.elements.has(target.css) ? { x: 0, y: 0, width: 10, height: 10 } : null),
    click: async () => {},
    type: async () => {},
    text: async () => "",
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    evaluate: async <T>() => undefined as T,
    close: async () => {},
  };
  const opts = async () => ({
    name: "test",
    log: () => {},
    now: () => t,
    sleep: async (ms: number) => void (t += ms),
    pollMs: 100,
    handoffMs: 1_000,
    artifactsDir: await mkdtemp(path.join(os.tmpdir(), "sikrets-flow-")),
  });
  const step = (over: Partial<Step<{ runs: number }>>): Step<{ runs: number }> => ({
    id: "step",
    description: "a step",
    done: async () => false,
    run: async (_d, s) => void s.runs++,
    timeoutMs: 300,
    retries: 0,
    onExhausted: "abort",
    ...over,
  });
  return { page, driver, opts, step, clock: () => t, advance: async (ms: number) => void (t += ms) };
}

describe("runFlow", () => {
  test("a step already done is skipped, so re-running resumes instead of repeating", async () => {
    const h = harness();
    const state = { runs: 0 };
    const records = await runFlow(h.driver, [h.step({ done: async () => true })], state, await h.opts());
    expect(records[0]).toMatchObject({ status: "skipped", attempts: 0 });
    expect(state.runs).toBe(0);
  });

  test("retries exactly `retries` times, then fails as a timeout with its exit code", async () => {
    const h = harness();
    const state = { runs: 0 };
    const err = await runFlow(h.driver, [h.step({ retries: 2 })], state, await h.opts()).catch((e) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect(err.kind).toBe("timeout");
    expect(err.exitCode).toBe(EXIT_CODES.timeout);
    expect(state.runs).toBe(3);
    expect(await Bun.file(path.join(err.artifacts, "step.png")).exists()).toBe(true);
    expect((await Bun.file(path.join(err.artifacts, "run.json")).json()).failedStep).toBe("step");
  });

  test("succeeds on a later attempt and records how many it took", async () => {
    const h = harness();
    const state = { runs: 0 };
    const records = await runFlow(h.driver, [h.step({ retries: 3, done: async (_d, s) => s.runs >= 2 })], state, await h.opts());
    expect(records[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  test("a missing element is reported as `missing`, not a generic timeout", async () => {
    const h = harness();
    const run = async (d: Driver) => void (await waitFor(d, { css: "#create" }, "open-dialog", 500, { now: h.clock, sleep: h.advance }));
    const err = await runFlow(h.driver, [h.step({ id: "open-dialog", run })], { runs: 0 }, await h.opts()).catch((e) => e);
    expect(err.kind).toBe("missing");
    expect(err.message).toContain("#create");
  });

  test("handoff waits for the person, then continues with the next step", async () => {
    const h = harness();
    const opts = await h.opts();
    // The "person" finishes the step 400ms into the handoff.
    const done = async () => h.clock() >= 700;
    const records = await runFlow(h.driver, [h.step({ id: "captcha", done, onExhausted: "handoff" }), h.step({ id: "next", done: async () => true })], { runs: 0 }, opts);
    expect(records.map((r) => r.status)).toEqual(["done-by-human", "skipped"]);
  });

  test("handoff that nobody finishes fails as `needs-human`", async () => {
    const h = harness();
    const err = await runFlow(h.driver, [h.step({ onExhausted: "handoff" })], { runs: 0 }, await h.opts()).catch((e) => e);
    expect(err.kind).toBe("needs-human");
    expect(err.exitCode).toBe(23);
  });

  test("driver errors are classified as `driver` and stop the flow", async () => {
    const h = harness();
    const later = { ran: false };
    const steps = [
      h.step({ id: "boom", run: async () => Promise.reject(new Error("socket closed")) }),
      h.step({ id: "after", run: async () => void (later.ran = true) }),
    ];
    const err = await runFlow(h.driver, steps, { runs: 0 }, await h.opts()).catch((e) => e);
    expect(err.kind).toBe("driver");
    expect(later.ran).toBe(false);
  });

  test("same inputs, same outcome", async () => {
    const outcome = async () => {
      const h = harness();
      return runFlow(h.driver, [h.step({ retries: 1, done: async (_d, s) => s.runs >= 2 })], { runs: 0 }, await h.opts());
    };
    expect(await outcome()).toEqual(await outcome());
  });
});
