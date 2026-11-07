import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Secret } from "./secret.ts";
import { REVEAL } from "../constants.ts";

// The macOS clipboard, for `sikrets get --copy`. The value goes to pbcopy on stdin, never argv.
// Clearing is a detached shell that outlives the CLI: after the delay it empties the clipboard
// only if it still holds that value, which it checks by hash so the value isn't in its argv or env.

/** Tests replace these. */
export const clipboard = {
  async copy(value: Secret): Promise<void> {
    if (process.platform !== "darwin") throw new Error("--copy needs macOS (pbcopy)");
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    proc.stdin.write(value.reveal());
    await proc.stdin.end();
    if ((await proc.exited) !== 0) throw new Error("Couldn't copy to the clipboard");
  },
  clearLater(value: Secret, seconds: number = REVEAL.clipboardClearSeconds): void {
    const hash = createHash("sha256").update(value.reveal()).digest("hex");
    const script = `sleep "$1"; [ "$(pbpaste | shasum -a 256)" = "$${REVEAL.clipboardHashEnv}  -" ] && printf '' | pbcopy`;
    const child = spawn("/bin/sh", ["-c", script, "sh", String(seconds)], {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", [REVEAL.clipboardHashEnv]: hash },
    });
    child.unref();
  },
};
