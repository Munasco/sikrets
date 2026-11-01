import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { configDir } from "../../store.ts";
import { LOGINS } from "../../constants.ts";
import type { Approver, Decision } from "./grants.ts";

// The person's answer to "may this agent use this login?", asked natively on macOS. A dialog
// offers Deny / Allow once / Always allow; an allow is then confirmed with Touch ID (or the Mac's
// password). The second step matters: an agent with screen control could click a dialog button,
// but it can't put a finger on the sensor. If the Touch ID helper can't be built (no Swift
// toolchain), the dialog alone decides. Anywhere else, nobody can be asked, so the answer is deny.

const BUTTONS = { deny: "Deny", once: "Allow once", always: "Always allow" } as const;

// Arguments go in through argv, never spliced into the script, so an agent name can't inject AppleScript.
const DIALOG = [
  "on run argv",
  `set r to display dialog (item 1 of argv) with title "${LOGINS.dialogTitle}" buttons {"${BUTTONS.deny}", "${BUTTONS.once}", "${BUTTONS.always}"} ` +
    `default button "${BUTTONS.once}" cancel button "${BUTTONS.deny}" with icon caution giving up after (item 2 of argv as integer)`,
  "if gave up of r then return \"\"",
  "return button returned of r",
  "end run",
];

const TOUCH_ID_SWIFT = `import Foundation
import LocalAuthentication
let context = LAContext()
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { exit(2) }
let done = DispatchSemaphore(value: 0)
var ok = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: CommandLine.arguments.dropFirst().first ?? "approve") { success, _ in
  ok = success
  done.signal()
}
done.wait()
exit(ok ? 0 : 1)
`;

/** Builds the Touch ID helper once per version of its source. Undefined when it can't be built. */
export async function touchIdHelper(): Promise<string | undefined> {
  const hash = createHash("sha256").update(TOUCH_ID_SWIFT).digest("hex").slice(0, 12);
  const bin = path.join(configDir(), `${LOGINS.touchIdBin}-${hash}`);
  if (await Bun.file(bin).exists()) return bin;
  const swiftc = Bun.which("swiftc");
  if (!swiftc) return undefined;
  await mkdir(path.dirname(bin), { recursive: true, mode: 0o700 });
  const src = `${bin}.swift`;
  await Bun.write(src, TOUCH_ID_SWIFT);
  const proc = Bun.spawn([swiftc, "-O", src, "-o", bin], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  await Bun.file(src).delete().catch(() => undefined);
  return code === 0 ? bin : undefined;
}

/** 0: confirmed, 1: refused or cancelled, 2: no Touch ID or password available on this Mac. */
async function confirmWithTouchId(reason: string): Promise<"yes" | "no" | "unavailable"> {
  const bin = await touchIdHelper();
  if (!bin) return "unavailable";
  const code = await Bun.spawn([bin, reason], { stdout: "ignore", stderr: "ignore" }).exited;
  return code === 0 ? "yes" : code === 2 ? "unavailable" : "no";
}

export const macApprover: Approver = async ({ login, origin, agent }) => {
  if (process.platform !== "darwin") return "deny";
  const message = `"${agent}" wants to sign in to ${login} (${origin}).\n\nIt won't see the password or the 2FA code.`;
  const proc = Bun.spawn(["osascript", ...DIALOG.flatMap((l) => ["-e", l]), message, String(LOGINS.approvalTimeoutSeconds)], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const button = code === 0 ? out.trim() : BUTTONS.deny; // the cancel button exits non-zero
  const decision: Decision = button === BUTTONS.always ? "always" : button === BUTTONS.once ? "once" : "deny";
  if (decision === "deny") return decision;
  const confirmed = await confirmWithTouchId(`let ${agent} sign in to ${login}`);
  return confirmed === "no" ? "deny" : decision;
};
