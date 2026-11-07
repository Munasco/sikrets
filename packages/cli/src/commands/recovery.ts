import path from "node:path";
import { ensureDataKey, fingerprint, loadDataKey, saveDataKey } from "../core/datakey.ts";
import { createRecord, isShare, markUsed, newCode, readRecord, recordState, recoveryFile, replaceRecord, secretFrom, unwrap, wrap, writeRecord, type RecoveryRecord } from "../core/recovery.ts";
import { effectiveVault, hasConfig, loadConfig } from "../core/config.ts";
import { envelopeKind } from "../core/envelope.ts";
import { ssmParams } from "../core/vault.ts";
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

/** What `status` reports. Only "ok" means the code you hold restores this device's key. */
export type RecoveryStatus = "not set up" | "no key on this device" | "mismatch" | "used" | "ok";

export function recoveryStatus(record: RecoveryRecord | undefined, key: Uint8Array | undefined): RecoveryStatus {
  if (!record) return "not set up";
  if (!key) return "no key on this device";
  if (fingerprint(key) !== record.fingerprint) return "mismatch";
  return recordState(record) === "used" ? "used" : "ok";
}

async function status(opts: Record<string, unknown>) {
  const [record, key] = [await readRecord(), await loadDataKey()];
  const state = recoveryStatus(record, key);
  const out = {
    state,
    setUp: Boolean(record),
    createdAt: record?.createdAt,
    split: record?.split,
    usedAt: record?.usedAt,
    matchesThisDevice: record && key ? fingerprint(key) === record.fingerprint : undefined,
    file: recoveryFile(),
  };
  if (opts.json) return console.log(JSON.stringify(out));
  if (!record) return console.log("Recovery isn't set up. Run: sikrets recovery setup");
  console.log(`Recovery set up ${record.createdAt.slice(0, 10)}${record.split ? ` (split ${RECOVERY.threshold}-of-${RECOVERY.shares})` : ""}.`);
  if (state === "mismatch") console.log("Warning: it unlocks a different data key than this device's. Run: sikrets recovery rotate");
  if (state === "used") console.log(`The code was used to restore on ${record.usedAt?.slice(0, 10)}. Replace it: sikrets recovery rotate`);
  if (state === "no key on this device") console.log("This device has no data key yet. To bring yours here, run: sikrets recovery restore");
}

/** setup and rotate: new code, new wrap. Rotating replaces the record, so the old code unlocks nothing. */
async function issue(action: "setup" | "rotate", opts: Record<string, unknown>, say: (m: string) => void) {
  const existing = await readRecord();
  if (action === "setup" && existing) throw new Error("Recovery is already set up. To replace the code, run: sikrets recovery rotate");
  if (action === "rotate" && !existing) throw new Error("Recovery isn't set up yet. Run: sikrets recovery setup");
  // An agent must never see the code; it is for a person, so this needs a real terminal.
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error(`Run this in a terminal: the recovery code is shown once, to a person`);
  if (action === "rotate" && !(await loadDataKey())) throw new Error("This device has no data key to protect. Run: sikrets recovery restore");

  if (!(await loadDataKey()) && (await sealedUnderAnotherKey(process.cwd()))) {
    throw new Error("This project's values are sealed under a data key this device doesn't have. Bring it here first: sikrets recovery restore");
  }
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

  if (action === "setup") await createRecord(record);
  else await replaceRecord(record, existing!.id);
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
  if (current && fingerprint(current) !== record.fingerprint && !opts.force) throw new Error("This device already has a different data key. Re-run with --force to replace it");
  const already = Boolean(current && fingerprint(current) === record.fingerprint);

  if (!already) await saveDataKey(key);
  if (file !== recoveryFile()) await writeRecord(record);
  // The code has now been typed on a device; it stays usable, but status asks for a fresh one.
  await markUsed(record.id);
  if (opts.json) console.log(JSON.stringify({ restored: !already, fingerprint: record.fingerprint, state: "used" }));
  else if (already) say("This device already has that data key. Nothing changed.");
  else say("Restored. This device can open your vault again.");
  if (!opts.json) say("That code has now been used. Replace it with a new one: sikrets recovery rotate");
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

/**
 * Whether the project here already has a data key elsewhere (claimed marker or sealed values). Setup
 * on a device without a key would otherwise mint a new one and protect the wrong key.
 */
async function sealedUnderAnotherKey(root: string): Promise<boolean> {
  if (!(await hasConfig(root))) return false;
  const config = await loadConfig(root);
  if (effectiveVault(config) !== "ssm") return false;
  const params = await ssmParams(config.project);
  if (await params.marker()) return true;
  return [...(await params.list()).values()].some((v) => envelopeKind(v) !== "plain");
}
