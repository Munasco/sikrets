import { confirm } from "../ui.ts";
import { swiftHelper } from "./swift.ts";
import { reasonText, type Answer, type ApprovalRequest } from "./approvals.ts";
import touchIdSource from "../native/touchid.swift" with { type: "text" };
import { DOORMAN, REVEAL } from "../constants.ts";

// How the Doorman asks a person on this machine. On macOS: Touch ID through a tiny Swift
// LocalAuthentication helper (compiled on first use with swiftc and cached under ~/.sikrets/bin),
// falling back to an osascript dialog. Elsewhere: a terminal prompt. With no way to reach a
// person the request just stays pending. Prompt text is the generic reason only.

export const promptText = (req: ApprovalRequest) => `${reasonText(req.reason)}. Rotate "${req.resource}" now? The old key will stop working.`;

/** Builds the Touch ID helper once per source version. Undefined when swiftc isn't installed. */
const touchIdHelper = () => swiftHelper(touchIdSource, DOORMAN.helperName);

/** The helper's exit code (0 approved, 1 dismissed, 2 failed, 3 unavailable), or undefined when it can't be built. */
async function touchIdCode(text: string): Promise<number | undefined> {
  const bin = await touchIdHelper();
  if (!bin) return undefined;
  return Bun.spawn([bin, text], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function touchId(req: ApprovalRequest): Promise<Answer | undefined> {
  const code = await touchIdCode(promptText(req));
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

/** Why no system dialog can reach the Mac's owner from here, or undefined when one can. */
function noOwnerDialog(): string | undefined {
  if (process.platform !== "darwin") return "needs macOS (Touch ID or your login password)";
  if (Bun.env[REVEAL.ciEnv]) return "isn't available in CI";
  if (REVEAL.sshEnv.some((name) => Bun.env[name])) return "isn't available over SSH";
  const session = Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  if (session !== REVEAL.guiSession) return "needs a logged-in macOS desktop session";
  return undefined;
}

export type OwnerCheck = { ok: true } | { ok: false; reason: string };

/**
 * Proves the Mac's owner is at the keyboard: Touch ID, or the login password in the system
 * dialog. Only LocalAuthentication counts. There's no terminal or stdin fallback, since an agent
 * driving the terminal could answer those but can't answer the system dialog.
 */
async function authenticate(prompt: string): Promise<OwnerCheck> {
  const blocked = noOwnerDialog();
  if (blocked) return { ok: false, reason: `Authentication ${blocked}, so the real value stays hidden` };
  const code = await touchIdCode(prompt);
  if (code === 0) return { ok: true };
  if (code === undefined || code === 3) return { ok: false, reason: "Touch ID and the macOS password dialog aren't available here (the helper needs swiftc: xcode-select --install), so the real value stays hidden" };
  return { ok: false, reason: "Not authenticated, so the real value stays hidden" };
}

/** Tests replace `native.ask` and `native.authenticate`; everything else goes through them. */
export const native = {
  async ask(req: ApprovalRequest): Promise<Answer> {
    if (process.platform === "darwin") return (await touchId(req)) ?? dialog(req);
    return terminal(req);
  },
  authenticate,
};

/** Throws unless the owner authenticates. Call before anything shows or writes out a real value. */
export async function requireOwner(prompt: string): Promise<void> {
  const check = await native.authenticate(prompt);
  if (!check.ok) throw new Error(check.reason);
}
