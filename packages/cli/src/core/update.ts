import { chmod, link, rename, rm } from "node:fs/promises";
import { RELEASES, REPO, UPDATE, USER_AGENT, releaseAsset } from "../constants.ts";

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

/** True when `a` is a newer version than `b`, by semver precedence (a prerelease sorts before its release). */
export function isNewer(a: string, b: string) {
  return compareVersions(a, b) > 0;
}

/**
 * Semver 2.0 precedence. Prerelease identifiers compare left to right: numbers numerically,
 * numbers before words, words as ASCII, and a shorter list first when one is a prefix of the
 * other (so rc.9 < rc.10, alpha < alpha.1 < beta). Build metadata (+…) is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, ...rest] = v.split("+", 1)[0]!.split("-");
    return { nums: core!.split(".").map(Number), pre: rest.length ? rest.join("-").split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i]!, y.pre[i]!];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
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

/**
 * Puts `bytes` in place of the binary at `target`, then runs `<target> --version` and puts the
 * previous binary back unless it prints `version`. `check` (e.g. provenance) runs on the new file
 * before the swap. Steps:
 *   write .new → check → keep the current one as .old → .new becomes target → --version → drop .old
 * POSIX keeps .old as a hard link, so there is never a moment without a sikrets; Windows can only
 * rename a running exe out of the way, so its .old stays until the next update removes it.
 */
export async function replaceBinary(target: string, bytes: Uint8Array, version: string, opts: { platform?: NodeJS.Platform; check?: (file: string) => Promise<void> } = {}) {
  const platform = opts.platform ?? process.platform;
  const next = `${target}.new`;
  const old = `${target}.old`;
  await recoverSwap(target);
  try {
    await Bun.write(next, bytes);
    await chmod(next, 0o755);
    await opts.check?.(next);
    await rm(old, { force: true });
    if (platform === "win32") await rename(target, old);
    else await link(target, old);
    try {
      await rename(next, target);
    } catch (error) {
      if (platform === "win32") await rename(old, target);
      throw error;
    }
  } catch (error) {
    await rm(next, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new Error(`No permission to replace ${target}. Re-run with sudo, or reinstall: curl -fsSL ${RELEASES.installScript} | sh`);
    throw error;
  }

  const reported = await versionOf(target);
  if (reported !== version) {
    if (platform === "win32") await rm(target, { force: true });
    await rename(old, target);
    throw new Error(`The new sikrets ${reported === undefined ? "didn't start" : `reported ${reported}`}, not ${version}; the previous version is back in place`);
  }
  if (platform !== "win32") await rm(old, { force: true });
}

/** What `<binary> --version` prints, or undefined if it doesn't run cleanly within a few seconds. */
async function versionOf(binary: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binary, "--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: UPDATE.versionCheckMs });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Settles a swap a crash interrupted. Windows can be left between its two renames with no
 * target, only .old (the version that worked) and .new; the old one goes back, so the update
 * simply didn't happen. A leftover .new next to a working target is removed.
 */
export async function recoverSwap(target: string) {
  const [hasTarget, hasOld] = await Promise.all([Bun.file(target).exists(), Bun.file(`${target}.old`).exists()]);
  if (!hasTarget && hasOld) await rename(`${target}.old`, target);
  else if (!hasTarget && (await Bun.file(`${target}.new`).exists())) await rename(`${target}.new`, target);
  await rm(`${target}.new`, { force: true });
}

/**
 * Checks the binary's GitHub build provenance with `gh attestation verify` when gh is installed:
 * it proves the file was built by this repository's release workflow, which SHA256SUMS (published
 * alongside the binary) can't. Verifying offline would need the Sigstore trust root and the
 * attestation bundle, so without gh this returns false and the caller says it wasn't checked.
 */
export async function verifyProvenance(file: string, gh = Bun.which("gh")): Promise<boolean> {
  if (!gh) return false;
  const proc = Bun.spawn([gh, "attestation", "verify", file, "--repo", REPO], { stdio: ["ignore", "ignore", "pipe"] });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`The download has no valid build provenance from ${REPO} (gh attestation verify: ${err.trim().split("\n").at(-1)}). Nothing was changed`);
  return true;
}
