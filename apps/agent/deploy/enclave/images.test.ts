import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// images.sh (host.sh's image slots and the switch between them), run in bash against a temp
// directory, with the enclave, systemd and KMS stubbed. Nothing here touches a real host.

const IMAGES = path.join(import.meta.dir, "images.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pcr = (name: string) => name.padEnd(96, "0");

function host() {
  const dir = mkdtempSync(path.join(tmpdir(), "sikrets-images-"));
  dirs.push(dir);
  const eif = path.join(dir, "agent.eif");
  const slotEif = (slot: string) => (slot === "cur" ? eif : `${eif}.${slot}`);
  const slotMeas = (slot: string) => path.join(dir, slot === "cur" ? "measurements.json" : `measurements.${slot}.json`);
  /** Puts image `name` (built from commit `sha`) in a slot. */
  const put = (slot: string, name: string, sha = `sha-${name}`) => {
    writeFileSync(slotEif(slot), `image ${name}`);
    writeFileSync(slotMeas(slot), JSON.stringify({ Measurements: { PCR0: pcr(name) } }));
    writeFileSync(`${slotEif(slot)}.sha`, `${sha}\n`);
  };
  /** Which image is in a slot, or undefined. */
  const at = (slot: string) => (existsSync(slotEif(slot)) ? readFileSync(slotEif(slot), "utf8").replace("image ", "") : undefined);
  const log = path.join(dir, "log");

  /** Runs a script with images.sh sourced and stub host functions. */
  const run = (script: string, env: Record<string, string> = {}) => {
    const prelude = `
      set -euo pipefail
      EIF='${eif}'; STATE='${dir}'
      . '${IMAGES}'
      stop_enclave() { echo stop >> '${log}'; }
      start_enclave() { echo "start $(sed "s/image //" "$EIF" 2>/dev/null)" >> '${log}'; [ "\${START_FAILS:-}" != 1 ]; }
      healthy() { echo healthy >> '${log}'; [ "\${HEALTHY:-1}" = 1 ]; }
      pinned_pcr0s() { printf '%s\\n' \${PINNED:-}; }
      head_sha() { echo "\${HEAD:-sha-n}"; }
      fallback() { echo fallback >> '${log}'; }
      trap undo_switch EXIT
    `;
    const p = Bun.spawnSync(["bash", "-c", prelude + script], { env: { PATH: process.env.PATH!, ...env } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const events = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { dir, put, at, run, events };
}

describe("up", () => {
  test("the new image starts, and the old one becomes prev only once it answers", () => {
    const h = host();
    h.put("cur", "a");
    h.put("prev", "p");
    h.put("new", "n");
    expect(h.run("switch new prev").code).toBe(0);
    expect([h.at("cur"), h.at("prev"), h.at("new"), h.at("out")]).toEqual(["n", "a", undefined, undefined]);
    expect(h.events()).toEqual(["stop", "start n", "healthy"]);
  });

  test("a new image that never answers is undone: the old one runs again and prev is untouched", () => {
    const h = host();
    h.put("cur", "a");
    h.put("prev", "p");
    h.put("new", "n");
    expect(h.run("switch new prev", { HEALTHY: "0" }).code).not.toBe(0);
    expect([h.at("cur"), h.at("prev"), h.at("new")]).toEqual(["a", "p", "n"]);
    expect(h.events()).toEqual(["stop", "start n", "healthy", "stop", "start a"]);
    expect(existsSync(path.join(h.dir, "switch"))).toBe(false);
  });

  test("a failed start under set -e is undone the same way", () => {
    const h = host();
    h.put("cur", "a");
    h.put("new", "n");
    expect(h.run("switch new prev", { START_FAILS: "1" }).code).not.toBe(0);
    expect([h.at("cur"), h.at("new")]).toEqual(["a", "n"]);
  });

  test("a run killed mid-switch (no trap) is undone by the next run", () => {
    const h = host();
    h.put("cur", "a");
    h.put("prev", "p");
    h.put("new", "n");
    // Killed right after the new image went into place.
    h.run(`start_enclave() { kill -9 $$; }; switch new prev`);
    expect(h.at("cur")).toBe("n");
    expect(h.at("out")).toBe("a");
    expect(h.run("resume_switch").code).toBe(0);
    expect([h.at("cur"), h.at("prev"), h.at("new"), h.at("out")]).toEqual(["a", "p", "n", undefined]);
  });

  test("a run killed after the new image answered finishes the switch instead of undoing it", () => {
    const h = host();
    h.put("cur", "a");
    h.put("prev", "p");
    h.put("new", "n");
    h.run(`move_slot() { if [ "$1" = out ]; then kill -9 $$; fi; command_move "$@"; }; command_move() { complete "$1" || return 1; clear_slot "$2"; mv -f "$(slot_eif "$1")" "$(slot_eif "$2")"; mv -f "$(slot_meas "$1")" "$(slot_meas "$2")"; mv -f "$(slot_sha "$1")" "$(slot_sha "$2")"; }; switch new prev`);
    expect(h.at("out")).toBe("a");
    expect(h.run("resume_switch").code).toBe(0);
    expect([h.at("cur"), h.at("prev"), h.at("out")]).toEqual(["n", "a", undefined]);
    expect(h.events().filter((e) => e.startsWith("start"))).toEqual(["start n"]);
  });

  test("a first deploy that fails falls back to serving from the host", () => {
    const h = host();
    h.put("new", "n");
    expect(h.run("switch new prev", { HEALTHY: "0" }).code).not.toBe(0);
    expect([h.at("cur"), h.at("new")]).toEqual([undefined, "n"]);
    expect(h.events().at(-1)).toBe("fallback");
  });

  test("only an image built from the checked-out commit starts", () => {
    const h = host();
    h.put("new", "n", "sha-old");
    expect(h.run("check_new", { HEAD: "sha-head" }).code).toBe(2);
    expect(h.run("check_new", { HEAD: "sha-old" }).code).toBe(0);
    expect(h.run("check_new", { HEAD: "sha-head", FORCE: "1" }).code).toBe(0);
  });

  test("an image the KMS key doesn't allow is refused", () => {
    const h = host();
    h.put("new", "n");
    expect(h.run("check_pinned new", { PINNED: pcr("a") }).code).not.toBe(0);
    expect(h.run("check_pinned new", { PINNED: `${pcr("a")} ${pcr("n")}` }).code).toBe(0);
    expect(h.run("check_pinned new", { PINNED: pcr("a"), FORCE: "1" }).code).toBe(0);
    // Can't tell: refused too.
    expect(h.run("pinned_pcr0s() { return 1; }; check_pinned new").code).not.toBe(0);
  });
});

describe("rollback", () => {
  test("the bad image goes to rejected, never back to new, so the next up rebuilds", () => {
    const h = host();
    h.put("cur", "n");
    h.put("prev", "a");
    expect(h.run("switch prev rejected").code).toBe(0);
    expect([h.at("cur"), h.at("rejected"), h.at("new"), h.at("prev")]).toEqual(["a", "n", undefined, undefined]);
    expect(h.run("complete new").code).not.toBe(0);
  });

  test("a previous image without its measurements is refused before anything moves", () => {
    const h = host();
    h.put("cur", "n");
    h.put("prev", "a");
    rmSync(path.join(h.dir, "measurements.prev.json"));
    expect(h.run("switch prev rejected").code).not.toBe(0);
    expect(h.at("cur")).toBe("n");
    expect(existsSync(path.join(h.dir, "measurements.json"))).toBe(true);
    expect(h.events()).toEqual([]);
  });
});

describe("build", () => {
  test("clearing the new slot first leaves nothing stale if the build then fails", () => {
    const h = host();
    h.put("new", "old-build");
    expect(h.run("clear_slot new; false").code).not.toBe(0);
    expect(h.at("new")).toBeUndefined();
    expect(existsSync(path.join(h.dir, "agent.eif.new.sha"))).toBe(false);
  });
});
