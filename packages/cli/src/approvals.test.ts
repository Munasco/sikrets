import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyEvent, approvals, decide, requestRotation, transition, type Answer, type ApprovalRequest } from "./core/approvals.ts";
import { native, promptText } from "./core/doorman.ts";
import { state, type Resource } from "./core/state.ts";
import * as rotateCommand from "./commands/rotate.ts";

// The native prompt (Touch ID / dialog) is always mocked: tests never reach a real person.
let root: string;
let rotated: string[];
const rotate = async (resource: string) => void rotated.push(resource);
const answer = (a: Answer) => async () => a;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sikrets-approvals-"));
  rotated = [];
});

afterEach(() => rm(root, { recursive: true, force: true }));

const pending = async (resource = "cache") => (await requestRotation(root, resource, "exposed")).request;

describe("approval state machine", () => {
  test("only allowed moves", () => {
    const req: ApprovalRequest = { id: "apr_1", resource: "cache", reason: "exposed", status: "pending", createdAt: "", expiresAt: "" };
    const approved = transition(req, "approve", { by: "touchid" });
    expect(approved).toMatchObject({ status: "rotating", decidedBy: "touchid" });
    expect(transition(approved, "rotated").status).toBe("rotated");
    const failed = transition(approved, "fail");
    expect(transition(failed, "approve").status).toBe("rotating"); // failed is retryable
    expect(transition(failed, "deny").status).toBe("denied"); // ...or can be closed
    expect(transition(failed, "expire").status).toBe("expired");
    expect(() => transition(approved, "approve")).toThrow("rotating");
    expect(transition(req, "deny").status).toBe("denied");
    expect(() => transition(req, "rotated")).toThrow("pending");
    expect(() => transition(transition(req, "deny"), "approve")).toThrow("denied");
    expect(() => transition(transition(req, "expire"), "approve")).toThrow("expired");
  });

  test("a trigger files one pending request per resource, with a generic reason only", async () => {
    const first = await requestRotation(root, "cache", "exposed");
    const again = await requestRotation(root, "cache", "expired");
    expect(first.created).toBe(true);
    expect(again).toEqual({ request: first.request, created: false });
    expect(await approvals.load(root)).toHaveLength(1);
    expect(promptText(first.request)).toBe('We think this key may be exposed. Rotate "cache" now? The old key will stop working.');
    expect(Object.keys(first.request).sort()).toEqual(["createdAt", "expiresAt", "id", "reason", "resource", "status"]);
    expect((await Bun.file(path.join(root, ".gitignore")).text()).split("\n")).toContain(".sikrets/approvals.json");
  });

  test("pending requests lapse after the TTL", async () => {
    const req = await pending();
    const later = new Date(Date.parse(req.expiresAt) + 1);
    expect((await approvals.load(root, later))[0]!.status).toBe("expired");
    await writeFile(path.join(root, ".sikrets/approvals.json"), JSON.stringify([{ ...req, expiresAt: new Date(Date.now() - 1).toISOString() }]));
    await expect(decide(root, req, answer({ decision: "approve", by: "touchid" }), rotate)).rejects.toThrow("expired");
    expect(rotated).toEqual([]);
  });

  test("approve rotates; deny and dismiss don't", async () => {
    const out = await decide(root, await pending("cache"), answer({ decision: "approve", by: "touchid" }), rotate);
    expect(out).toMatchObject({ status: "rotated", decidedBy: "touchid" });
    expect(out.rotatedAt).toBeString();
    expect(rotated).toEqual(["cache"]);

    expect((await decide(root, await pending("db"), answer({ decision: "deny", by: "dialog" }), rotate)).status).toBe("denied");
    const still = await decide(root, await pending("queue"), answer({ decision: "dismissed" }), rotate);
    expect(still.status).toBe("pending");
    expect(rotated).toEqual(["cache"]);
    expect((await approvals.load(root)).map((r) => [r.resource, r.status])).toEqual([
      ["cache", "rotated"],
      ["db", "denied"],
      ["queue", "pending"],
    ]);
  });

  test("a failed rotation is recorded and can be approved again", async () => {
    const req = await pending();
    await expect(decide(root, req, answer({ decision: "approve", by: "dialog" }), async () => { throw new Error("provider down"); })).rejects.toThrow("provider down");
    const failed = await approvals.find(root, req.id);
    expect(failed.status).toBe("failed");
    expect((await decide(root, failed, answer({ decision: "approve", by: "touchid" }), rotate)).status).toBe("rotated");
  });
});

describe("decisions apply to the request as stored, not a stale copy", () => {
  // Stands in for a Touch ID prompt that is open while something else changes the request.
  const meanwhile = (fn: () => Promise<unknown>, a: Answer) => async () => {
    await fn();
    return a;
  };

  test("a deny that lands while the prompt is open wins; nothing rotates", async () => {
    const req = await pending();
    const ask = meanwhile(() => applyEvent(root, req.id, "deny", { by: "cli" }), { decision: "approve", by: "touchid" });
    await expect(decide(root, req, ask, rotate)).rejects.toThrow("denied");
    expect((await approvals.find(root, req.id)).status).toBe("denied");
    expect(rotated).toEqual([]);
  });

  test("two approvals of the same request rotate once", async () => {
    const req = await pending();
    const second = () => decide(root, req, answer({ decision: "approve", by: "dialog" }), rotate);
    await expect(decide(root, req, meanwhile(second, { decision: "approve", by: "touchid" }), rotate)).rejects.toThrow("rotated");
    expect((await approvals.find(root, req.id)).status).toBe("rotated");
    expect(rotated).toEqual(["cache"]);
  });

  test("a request that expires while the prompt is open can't be approved", async () => {
    const req = await pending();
    await writeFile(path.join(root, ".sikrets/approvals.json"), JSON.stringify([{ ...req, expiresAt: new Date(Date.now() + 50).toISOString() }]));
    const ask = meanwhile(() => Bun.sleep(80), { decision: "approve", by: "touchid" });
    await expect(decide(root, req, ask, rotate)).rejects.toThrow("expired");
    expect(rotated).toEqual([]);
  });

  test("concurrent writers don't lose each other's requests", async () => {
    await Promise.all(["a", "b", "c", "d", "e", "f"].map((r) => requestRotation(root, r, "exposed")));
    expect((await approvals.load(root)).map((r) => r.resource).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("a rotation whose process died is recorded as failed, and can then be denied", async () => {
    const req = await pending();
    const dead = 2 ** 22 + 12345; // above any real pid
    const crashed = { ...req, status: "rotating", decidedAt: new Date().toISOString(), rotation: { pid: dead, startedAt: new Date().toISOString() } };
    await writeFile(path.join(root, ".sikrets/approvals.json"), JSON.stringify([crashed]));
    const now = await approvals.find(root, req.id);
    expect(now).toMatchObject({ status: "failed", error: expect.stringContaining("interrupted") });
    expect((await applyEvent(root, req.id, "deny", { by: "cli" })).status).toBe("denied");
  });

  test("files from before the rotating state still load", async () => {
    const req = await pending();
    await writeFile(path.join(root, ".sikrets/approvals.json"), JSON.stringify([{ ...req, status: "approved" }]));
    expect((await approvals.find(root, req.id)).status).toBe("failed"); // no running process: interrupted
  });

  test("a failed request blocks a second one for the same resource and gets a fresh window", async () => {
    const req = await pending();
    await Bun.sleep(5);
    await applyEvent(root, req.id, "approve", { by: "touchid" });
    const failed = await applyEvent(root, req.id, "fail");
    expect(Date.parse(failed.expiresAt)).toBeGreaterThan(Date.parse(req.expiresAt));
    expect(await requestRotation(root, "cache", "expired")).toMatchObject({ created: false, request: { id: req.id } });
  });

  test("a stale lock left by a dead process is broken", async () => {
    await writeFile(path.join(root, ".sikrets/approvals.json.lock"), String(2 ** 22 + 1)).catch(async () => {
      await Bun.write(path.join(root, ".sikrets/approvals.json.lock"), String(2 ** 22 + 1));
    });
    expect((await requestRotation(root, "cache", "exposed")).created).toBe(true);
  });
});

describe("sikrets approvals", () => {
  const resource: Resource = { name: "cache", recipe: "upstash/redis", provider: "upstash", strategy: "api", inputs: {}, dependsOn: {}, envKeys: [], outputs: {}, applied: true, createdAt: "" };
  const inRoot = async (fn: () => Promise<void>) => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await fn();
    } finally {
      process.chdir(cwd);
    }
  };

  test("request asks the person through the native prompt and leaves it pending when dismissed", async () => {
    await state.upsert(root, resource);
    const ask = spyOn(native, "ask").mockImplementation(async () => ({ decision: "dismissed" }));
    const { run } = await import("./commands/approvals.ts");
    await inRoot(() => run(["request", "cache"], { reason: "exposed", json: true }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatchObject({ resource: "cache", reason: "exposed", status: "pending" });
    const [req] = await approvals.load(root);
    expect(req!.status).toBe("pending");

    // Deny needs no prompt and never rotates.
    await inRoot(() => run(["deny", req!.id], { json: true }));
    expect((await approvals.find(root, req!.id)).status).toBe("denied");
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockRestore();
  });

  test("--queue files without asking; unknown resources and reasons are refused", async () => {
    await state.upsert(root, resource);
    const ask = spyOn(native, "ask");
    const { run } = await import("./commands/approvals.ts");
    await inRoot(() => run(["request", "cache"], { queue: true, json: true }));
    expect(ask).not.toHaveBeenCalled();
    await inRoot(async () => {
      await expect(run(["request", "nope"], { queue: true })).rejects.toThrow('No resource named "nope"');
      await expect(run(["request", "cache"], { reason: "github", queue: true })).rejects.toThrow("--reason must be one of");
    });
    ask.mockRestore();
  });

  test("approve goes through the native prompt, then runs the existing rotate", async () => {
    await state.upsert(root, resource);
    const ask = spyOn(native, "ask").mockImplementation(async () => ({ decision: "approve", by: "touchid" }));
    const rotateRun = spyOn(rotateCommand, "run").mockImplementation(async () => {});
    const { request } = await requestRotation(root, "cache", "expired");
    const { run } = await import("./commands/approvals.ts");
    await inRoot(() => run(["approve", request.id], { json: true }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(rotateRun).toHaveBeenCalledWith(["cache"], { yes: true });
    expect((await approvals.find(root, request.id)).status).toBe("rotated");
    const { readActivity } = await import("./core/activity.ts");
    expect((await readActivity(root)).at(-1)).toMatchObject({ kind: "approval", detail: `${request.id} cache rotated via touchid` });
    ask.mockRestore();
    rotateRun.mockRestore();
  });
});
