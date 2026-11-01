import { realpath } from "node:fs/promises";
import path from "node:path";
import { RELEASES } from "../constants.ts";
import { downloadVerified, isNewer, latestRelease, replaceBinary } from "../core/update.ts";
import { log } from "../ui.ts";

// Only a standalone binary from a release can replace itself. Running from source (bun) or from
// Homebrew, the right update is git pull or brew upgrade, so say that instead.
async function installedBinary() {
  if (/^bun(\.exe)?$/i.test(path.basename(process.execPath))) throw new Error("Running from source; update with git pull");
  const target = await realpath(process.execPath);
  if (target.includes("/Cellar/")) throw new Error("Installed with Homebrew; update with: brew upgrade sikrets");
  return target;
}

export async function run(_args: string[], opts: { check?: boolean; json?: boolean }) {
  const current = (await import("../../package.json")).version;
  const latest = await latestRelease();
  const available = isNewer(latest.version, current);
  if (opts.check || !available) {
    if (opts.json) return console.log(JSON.stringify({ current, latest: latest.version, available, updated: false }));
    return console.log(available ? `sikrets ${latest.version} is available (you have ${current}). Run: sikrets update` : `sikrets ${current} is up to date`);
  }

  const target = await installedBinary();
  log(opts, `Downloading sikrets ${latest.version} and checking it against ${RELEASES.checksums}…`);
  await replaceBinary(target, await downloadVerified(latest.tag));
  if (opts.json) return console.log(JSON.stringify({ current, latest: latest.version, available, updated: true, path: target }));
  console.log(`Updated sikrets ${current} → ${latest.version} (${target})`);
}
