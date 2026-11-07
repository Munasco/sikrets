import { createHash } from "node:crypto";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { configDir } from "../store.ts";
import { privateDir, remove } from "./fs.ts";
import { DOORMAN } from "../constants.ts";

// Small Swift helpers for what only macOS frameworks can do (Touch ID, the Secure Enclave). The
// source is embedded in the CLI; it is compiled with swiftc on first use and cached under
// ~/.sikrets/bin, one binary per source version. swiftc signs the result ad hoc, which is enough
// for LocalAuthentication and for Secure Enclave keys that aren't stored in the keychain.

/** The helper's path, building it if needed. Undefined when swiftc isn't installed or the build fails. */
export async function swiftHelper(source: string, name: string, opts: { link?: boolean } = {}): Promise<string | undefined> {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const dir = path.join(configDir(), DOORMAN.binDir);
  const bin = path.join(dir, `${name}-${hash}`);
  if (!(await Bun.file(bin).exists())) {
    if (!Bun.which("swiftc")) return undefined;
    await privateDir(dir);
    const src = `${bin}.swift`;
    await Bun.write(src, source);
    const build = Bun.spawn(["swiftc", "-O", "-swift-version", "5", "-o", bin, src], { stdout: "ignore", stderr: "ignore" });
    const ok = (await build.exited) === 0;
    await Bun.file(src).delete();
    if (!ok) return undefined;
  }
  // A stable name for other processes (the SDK) to run, pointing at the current build.
  if (opts.link) {
    const stable = path.join(dir, name);
    await remove(stable).catch(() => {});
    await symlink(path.basename(bin), stable).catch(() => {});
  }
  return bin;
}
