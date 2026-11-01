// Compiles the sikrets CLI to one binary and puts it where Tauri bundles sidecars:
// src-tauri/binaries/sikrets-<target triple>. Run before `bun tauri dev` or `bun tauri build`.
import path from "node:path";
import { mkdir, copyFile, chmod } from "node:fs/promises";

const cli = path.resolve(import.meta.dir, "../../../packages/cli");
const out = path.resolve(import.meta.dir, "../src-tauri/binaries");

const rustc = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe" });
const triple = /host: (\S+)/.exec(rustc.stdout.toString())?.[1];
if (!triple) throw new Error("Couldn't read the target triple from `rustc -vV`; is Rust installed?");

const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: cli, stdout: "inherit", stderr: "inherit" });
if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);
const build = Bun.spawnSync(["bun", "run", "build"], { cwd: cli, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

await mkdir(out, { recursive: true });
const dest = path.join(out, `sikrets-${triple}`);
await copyFile(path.join(cli, "dist/sikrets"), dest);
await chmod(dest, 0o755);
console.log(`sidecar: ${path.relative(process.cwd(), dest)}`);
