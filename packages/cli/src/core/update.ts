import { chmod, rename, rm } from "node:fs/promises";
import { RELEASES, USER_AGENT, releaseAsset } from "../constants.ts";

// Self-update from GitHub releases. Every download is checked against the release's SHA256SUMS
// before it touches the installed binary, and the swap is a rename so a failure never leaves a
// half-written sikrets behind.

export interface Release {
  tag: string;
  version: string;
}

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

async function get(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res;
}

export async function latestRelease(): Promise<Release> {
  const res = await fetch(RELEASES.latest, { headers: { "User-Agent": USER_AGENT } });
  if (res.status === 404) throw new Error(`No release published yet at ${RELEASES.page}`);
  if (!res.ok) throw new Error(`GET ${RELEASES.latest} failed: ${res.status}`);
  const { tag_name } = (await res.json()) as { tag_name?: string };
  // The tag ends up in a download URL, so only accept a plain version tag.
  const version = tag_name?.match(TAG)?.[1];
  if (!tag_name || !version) throw new Error(`Unexpected release tag "${tag_name}"`);
  return { tag: tag_name, version };
}

/** True when `a` is a newer version than `b`. A prerelease sorts before its release. */
export function isNewer(a: string, b: string) {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core!.split(".").map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  if (x.pre === y.pre) return false;
  return !x.pre || (!!y.pre && x.pre > y.pre);
}

/** Parses `sha256sum` output: "<hex>  <name>" per line (a leading * marks binary mode). */
export function parseChecksums(text: string) {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) sums.set(m[2]!, m[1]!.toLowerCase());
  }
  return sums;
}

export const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Downloads this platform's binary for a release and returns it only if its checksum matches. */
export async function downloadVerified(tag: string, asset = releaseAsset(process.platform, process.arch)) {
  const base = `${RELEASES.download}/${tag}`;
  const expected = parseChecksums(await (await get(`${base}/${RELEASES.checksums}`)).text()).get(asset);
  if (!expected) throw new Error(`${tag} has no ${asset} in ${RELEASES.checksums}; this platform may not be published`);
  const bytes = new Uint8Array(await (await get(`${base}/${asset}`)).arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was changed`);
  return bytes;
}

/** Puts `bytes` in place of the binary at `target`, via a sibling file and a rename. */
export async function replaceBinary(target: string, bytes: Uint8Array, platform = process.platform) {
  const next = `${target}.new`;
  const old = `${target}.old`;
  let moved = false;
  try {
    await Bun.write(next, bytes);
    await chmod(next, 0o755);
    // Windows won't overwrite a running .exe but will rename it out of the way.
    if (platform === "win32") {
      await rm(old, { force: true });
      await rename(target, old);
      moved = true;
    }
    await rename(next, target);
  } catch (error) {
    if (moved) await rename(old, target).catch(() => {});
    await rm(next, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error(`No permission to replace ${target}. Re-run with sudo, or reinstall: curl -fsSL ${RELEASES.installScript} | sh`);
    throw error;
  }
}
