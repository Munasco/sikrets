import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../fs.ts";
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

/** Where the helper's expected hash is kept: the keychain by default, a map in tests. */
export interface HelperPin {
  get(): Promise<string | null>;
  set(hash: string): Promise<void>;
}

const keychainPin: HelperPin = {
  get: () => Bun.secrets.get({ service: LOGINS.keychainService, name: LOGINS.touchIdPin }),
  set: (value) => Bun.secrets.set({ service: LOGINS.keychainService, name: LOGINS.touchIdPin, value }),
};

export interface HelperOptions {
  /** Folder for the cached binary (default: the user dir). */
  dir?: string;
  pin?: HelperPin;
  /** Compiles `src` to `out`; true on success. Default: swiftc. */
  compile?: (src: string, out: string) => Promise<boolean>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function swiftc(src: string, out: string) {
  const bin = Bun.which("swiftc");
  if (!bin) return false;
  return (await Bun.spawn([bin, "-O", src, "-o", out], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
}

/**
 * The Touch ID helper's bytes, verified. Built once per version of its source into a temp file
 * that is renamed into place (so a half-built binary is never cached), one build at a time, and
 * its hash pinned in the keychain. A cached binary whose hash doesn't match the pin (planted,
 * swapped or corrupt) is thrown away and rebuilt. Undefined when it can't be built.
 */
export async function touchIdHelper(opts: HelperOptions = {}): Promise<Uint8Array | undefined> {
  const source = createHash("sha256").update(TOUCH_ID_SWIFT).digest("hex").slice(0, 12);
  const bin = path.join(opts.dir ?? configDir(), `${LOGINS.touchIdBin}-${source}`);
  const pin = opts.pin ?? keychainPin;
  await mkdir(path.dirname(bin), { recursive: true, mode: 0o700 });
  return withFileLock(bin, async () => {
    const cached = Bun.file(bin);
    if (await cached.exists()) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (sha256(bytes) === (await pin.get().catch(() => null))) return bytes;
      await unlink(bin).catch(() => undefined);
    }
    const tmp = `${bin}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      await Bun.write(`${tmp}.swift`, TOUCH_ID_SWIFT);
      if (!(await (opts.compile ?? swiftc)(`${tmp}.swift`, tmp))) return undefined;
      const bytes = new Uint8Array(await Bun.file(tmp).arrayBuffer());
      await pin.set(sha256(bytes));
      await rename(tmp, bin);
      return bytes;
    } finally {
      await unlink(`${tmp}.swift`).catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
    }
  });
}

/** 0: confirmed, 1: refused or cancelled, 2: no Touch ID or password available on this Mac. */
async function confirmWithTouchId(reason: string): Promise<"yes" | "no" | "unavailable"> {
  const bytes = await touchIdHelper().catch(() => undefined);
  if (!bytes) return "unavailable";
  // Run the exact bytes that were verified, from a private folder of this call's own.
  const dir = await mkdtemp(path.join(os.tmpdir(), "sikrets-touchid-"));
  try {
    const exe = path.join(dir, "helper");
    await writeFile(exe, bytes, { mode: 0o700 });
    const code = await Bun.spawn([exe, reason], { stdout: "ignore", stderr: "ignore" }).exited;
    return code === 0 ? "yes" : code === 2 ? "unavailable" : "no";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const macApprover: Approver = async ({ login, origin, agent, program }) => {
  if (process.platform !== "darwin") return "deny";
  const from = program ? `\nProgram: ${program}` : "";
  const message = `"${agent}" wants to sign in to ${login} (${origin}).${from}\n\nIt won't see the password or the 2FA code.`;
  const proc = Bun.spawn(["osascript", ...DIALOG.flatMap((l) => ["-e", l]), message, String(LOGINS.approvalTimeoutSeconds)], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const button = code === 0 ? out.trim() : BUTTONS.deny; // the cancel button exits non-zero
  const decision: Decision = button === BUTTONS.always ? "always" : button === BUTTONS.once ? "once" : "deny";
  if (decision === "deny") return decision;
  const confirmed = await confirmWithTouchId(`let ${agent} sign in to ${login}`);
  return confirmed === "no" ? "deny" : decision;
};
