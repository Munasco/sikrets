import { createHash } from "node:crypto";
import path from "node:path";
import { configDir } from "../store.ts";
import { confirm } from "../ui.ts";
import { privateDir } from "./fs.ts";
import { reasonText, type Answer, type ApprovalRequest } from "./approvals.ts";
import touchIdSource from "../native/touchid.swift" with { type: "text" };
import { DOORMAN } from "../constants.ts";

// How the Doorman asks a person on this machine. On macOS: Touch ID through a tiny Swift
// LocalAuthentication helper (compiled on first use with swiftc and cached under ~/.sikrets/bin),
// falling back to an osascript dialog. Elsewhere: a terminal prompt. With no way to reach a
// person the request just stays pending. Prompt text is the generic reason only.

export const promptText = (req: ApprovalRequest) => `${reasonText(req.reason)}. Rotate "${req.resource}" now? The old key will stop working.`;

/** Builds the Touch ID helper once per source version. Undefined when swiftc isn't installed. */
async function touchIdHelper(): Promise<string | undefined> {
  const hash = createHash("sha256").update(touchIdSource).digest("hex").slice(0, 12);
  const dir = path.join(configDir(), DOORMAN.binDir);
  const bin = path.join(dir, `${DOORMAN.helperName}-${hash}`);
  if (await Bun.file(bin).exists()) return bin;
  if (!Bun.which("swiftc")) return undefined;
  await privateDir(dir);
  const src = `${bin}.swift`;
  await Bun.write(src, touchIdSource);
  const build = Bun.spawn(["swiftc", "-O", "-swift-version", "5", "-o", bin, src], { stdout: "ignore", stderr: "ignore" });
  const ok = (await build.exited) === 0;
  await Bun.file(src).delete();
  return ok ? bin : undefined;
}

async function touchId(req: ApprovalRequest): Promise<Answer | undefined> {
  const bin = await touchIdHelper();
  if (!bin) return undefined;
  const code = await Bun.spawn([bin, promptText(req)], { stdout: "ignore", stderr: "ignore" }).exited;
  if (code === 0) return { decision: "approve", by: "touchid" };
  if (code === 1) return { decision: "dismissed" };
  return undefined; // failed or unavailable: let the dialog ask instead
}

async function dialog(req: ApprovalRequest): Promise<Answer> {
  // The message goes in as argv, never spliced into the script, so names can't inject AppleScript.
  const script = [
    "on run argv",
    `display dialog (item 1 of argv) with title "${DOORMAN.title}" buttons {"${DOORMAN.denyButton}", "${DOORMAN.approveButton}"} default button "${DOORMAN.approveButton}" cancel button "${DOORMAN.denyButton}" with icon caution giving up after ${DOORMAN.dialogTimeoutSeconds}`,
    "end run",
  ];
  const proc = Bun.spawn(["osascript", ...script.flatMap((l) => ["-e", l]), promptText(req)], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = [await new Response(proc.stdout).text(), await proc.exited];
  if (code !== 0) return { decision: "deny", by: "dialog" }; // the cancel button is Deny
  if (out.includes("gave up:true")) return { decision: "dismissed" };
  return out.includes(`button returned:${DOORMAN.approveButton}`) ? { decision: "approve", by: "dialog" } : { decision: "dismissed" };
}

async function terminal(req: ApprovalRequest): Promise<Answer> {
  if (!process.stdin.isTTY) return { decision: "dismissed" };
  return (await confirm(promptText(req))) ? { decision: "approve", by: "terminal" } : { decision: "deny", by: "terminal" };
}

/** Tests replace `native.ask`; everything else goes through it. */
export const native = {
  async ask(req: ApprovalRequest): Promise<Answer> {
    if (process.platform === "darwin") return (await touchId(req)) ?? dialog(req);
    return terminal(req);
  },
};
