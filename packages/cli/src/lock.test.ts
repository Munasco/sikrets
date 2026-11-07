import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCK } from "./constants.ts";
import { processStart, withLock } from "./core/lock.ts";

let dir: string;
let file: string;
const sleeper = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sikrets-lock-"));
  file = path.join(dir, "state.json");
});
afterAll(() => sleeper.kill());

const plant = async (holder: object, ageMs = 0) => {
  const lock = file + LOCK.suffix;
  await Bun.write(lock, JSON.stringify(holder));
  const at = (Date.now() - ageMs) / 1000;
  await utimes(lock, at, at);
};

/** Whether withLock gets in before `ms`, i.e. the planted lock was treated as stale. */
const takesOver = async (ms = 300) =>
  Promise.race([withLock(file, async () => true), Bun.sleep(ms).then(() => false)]);

describe("file lock", () => {
  test("a live holder keeps its lock long after the old 30s limit (a long import)", async () => {
    await plant({ pid: sleeper.pid, start: processStart(sleeper.pid), at: 0, token: "busy" }, 5 * 60_000);
    expect(await takesOver()).toBe(false);
    await rm(file + LOCK.suffix, { force: true });
  });

  test("a dead holder's lock is broken", async () => {
    await plant({ pid: 999_999_999, at: 0, token: "dead" });
    expect(await takesOver()).toBe(true);
  });

  test("a pid now used by another process (different start time) is not the holder", async () => {
    await plant({ pid: sleeper.pid, start: "Thu Jan  1 00:00:00 1970", at: 0, token: "reused" });
    expect(await takesOver()).toBe(true);
  });

  test("a live holder past the ceiling is assumed hung", async () => {
    await plant({ pid: sleeper.pid, start: processStart(sleeper.pid), at: 0, token: "hung" }, LOCK.maxHoldMs + 60_000);
    expect(await takesOver()).toBe(true);
  });

  test("an unreadable (torn) lock is broken once it's old", async () => {
    await Bun.write(file + LOCK.suffix, '{"pid":');
    const at = (Date.now() - LOCK.unreadableMs - 1000) / 1000;
    await utimes(file + LOCK.suffix, at, at);
    expect(await takesOver()).toBe(true);
  });

  test("callers in turn, never together", async () => {
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withLock(file, async () => {
          most = Math.max(most, ++inside);
          await Bun.sleep(5);
          inside--;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(await Bun.file(file + LOCK.suffix).exists()).toBe(false);
  });
});
