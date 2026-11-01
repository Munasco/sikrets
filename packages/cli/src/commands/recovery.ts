import path from "node:path";
import { ensureDataKey, fingerprint, loadDataKey, saveDataKey } from "../core/datakey.ts";
import { isShare, newCode, readRecord, recoveryFile, secretFrom, unwrap, wrap, writeRecord, type RecoveryRecord } from "../core/recovery.ts";
import { log, promptHidden, promptLine } from "../ui.ts";
import { RECOVERY } from "../constants.ts";

// sikrets recovery [status|setup|restore|rotate]. The code is shown exactly once, only to a person
// at a terminal, and never written anywhere by Sikrets; only the wrapped data key is stored.

export async function run(args: string[], opts: Record<string, unknown>) {
  const action = args[0] ?? "status";
  const say = (m: string) => log(opts, m);
  switch (action) {
    case "status":
      return status(opts);
    case "setup":
    case "rotate":
      return issue(action, opts, say);
    case "restore":
      return restore(opts, say);
    default:
      throw new Error(`Unknown action "${action}". Use: sikrets recovery setup | restore | rotate`);
  }
}

async function status(opts: Record<string, unknown>) {
  const [record, key] = [await readRecord(), await loadDataKey()];
  const out = {
    setUp: Boolean(record),
    createdAt: record?.createdAt,
    split: record?.split,
    matchesThisDevice: record && key ? fingerprint(key) === record.fingerprint : undefined,
    file: recoveryFile(),
  };
  if (opts.json) return console.log(JSON.stringify(out));
  if (!record) return console.log("Recovery isn't set up. Run: sikrets recovery setup");
  console.log(`Recovery set up ${record.createdAt.slice(0, 10)}${record.split ? ` (split ${RECOVERY.threshold}-of-${RECOVERY.shares})` : ""}.`);
  if (out.matchesThisDevice === false) console.log("Warning: it unlocks a different data key than this device's. Run: sikrets recovery rotate");
}

/** setup and rotate: new code, new wrap. Rotating replaces the record, so the old code unlocks nothing. */
async function issue(action: "setup" | "rotate", opts: Record<string, unknown>, say: (m: string) => void) {
  const existing = await readRecord();
  if (action === "setup" && existing) throw new Error("Recovery is already set up. To replace the code, run: sikrets recovery rotate");
  if (action === "rotate" && !existing) throw new Error("Recovery isn't set up yet. Run: sikrets recovery setup");
  // An agent must never see the code; it is for a person, so this needs a real terminal.
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error(`Run this in a terminal: the recovery code is shown once, to a person`);
  if (action === "rotate" && !(await loadDataKey())) throw new Error("This device has no data key to protect. Run: sikrets recovery restore");

  const dataKey = await ensureDataKey();
  const split = Boolean(opts.split);
  const { secret, shown } = newCode({ split });
  say("Deriving the wrapping key…");
  const record = await wrap(dataKey, secret, { split });

  process.stderr.write("\nWrite this down and keep it offline. It is shown once; Sikrets can't recover it for you.\n\n");
  if (split) {
    process.stderr.write(`Any ${RECOVERY.threshold} of these ${RECOVERY.shares} shares restore access. Keep one, give the others to people you trust:\n\n`);
    for (const [i, s] of shown.entries()) process.stderr.write(`  Share ${i + 1}:  ${s}\n`);
  } else {
    process.stderr.write(`  ${shown[0]}\n`);
  }
  process.stderr.write("\n");
  const last = shown[0]!.split("-").at(-1)!;
  const typed = await promptLine(`To confirm you saved it, type the last group${split ? " of share 1" : ""}: `);
  if (typed.toUpperCase() !== last) throw new Error(`That doesn't match. Nothing changed; run sikrets recovery ${action} again`);

  await writeRecord(record);
  say(action === "rotate" ? "New recovery code active. The previous code no longer unlocks anything." : "Recovery is set up.");
  say(`The wrapped key is in ${recoveryFile()}. It is useless without the code; keep a copy off this device.`);
}

async function restore(opts: Record<string, unknown>, say: (m: string) => void) {
  const file = typeof opts.file === "string" ? path.resolve(opts.file) : recoveryFile();
  const record = await readRecord(file);
  if (!record) throw new Error(`No recovery record at ${file}. Pass the copy you kept with --file`);

  const secret = secretFrom(await readCodes(opts, record));
  say("Checking the code…");
  const key = await unwrap(record, secret);
  const current = await loadDataKey();
  if (current && fingerprint(current) === record.fingerprint) return say("This device already has that data key. Nothing changed.");
  if (current && !opts.force) throw new Error("This device already has a different data key. Re-run with --force to replace it");

  await saveDataKey(key);
  if (file !== recoveryFile()) await writeRecord(record);
  if (opts.json) console.log(JSON.stringify({ restored: true, fingerprint: record.fingerprint }));
  else say("Restored. This device can open your vault again. Consider `sikrets recovery rotate` if the code was written somewhere exposed.");
}

/** One code or enough shares, from stdin (one per line) or hidden prompts. Never from argv. */
async function readCodes(opts: Record<string, unknown>, record: RecoveryRecord): Promise<string[]> {
  if (opts["code-stdin"]) return (await Bun.stdin.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = await promptHidden(record.split ? "Recovery share: " : "Recovery code: ");
  if (!isShare(first)) return [first];
  const inputs = [first];
  while (inputs.length < RECOVERY.threshold) inputs.push(await promptHidden(`Another share (${inputs.length + 1} of ${RECOVERY.threshold}): `));
  return inputs;
}
