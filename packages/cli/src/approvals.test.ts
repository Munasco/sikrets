import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvals, decide, requestRotation, transition, type Answer, type ApprovalRequest } from "./core/approvals.ts";
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
    expect(approved).toMatchObject({ status: "approved", decidedBy: "touchid" });
    expect(transition(approved, "rotated").status).toBe("rotated");
    expect(transition(transition(approved, "fail"), "approve").status).toBe("approved"); // failed is retryable
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
    await expect(decide(root, (await approvals.load(root, later))[0]!, answer({ decision: "approve", by: "touchid" }), rotate)).rejects.toThrow("expired");
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
