import QRCode from "qrcode";
import { beginPairing, forgetPairing, loadPairing, relayUrl } from "../core/pairing.ts";
import { log } from "../ui.ts";
import { RELAY } from "../constants.ts";

// sikrets pair: shows a QR code holding this laptop's public key, a fresh pairing secret and the
// relay URL. The phone scans it, answers with its own public keys through the relay, and from then
// on approval requests reach the phone end-to-end encrypted. The code is shown, never printed as
// text or logged: anyone holding it during the pairing window could pair instead.

export async function run(_args: string[], opts: Record<string, unknown>) {
  const say = (m: string) => log(opts, m);
  if (opts.forget) {
    await forgetPairing();
    if (opts.json) return console.log(JSON.stringify({ paired: false }));
    return say("Unpaired. Pair again with: sikrets pair");
  }
  if (opts.status) {
    const p = await loadPairing();
    if (opts.json) return console.log(JSON.stringify(p ? { paired: true, phone: p.phoneName, pairedAt: p.pairedAt, relay: p.relay } : { paired: false }));
    return console.log(p ? `Paired with ${p.phoneName} since ${p.pairedAt.slice(0, 16).replace("T", " ")} (relay ${p.relay}).` : "No phone paired. Run: sikrets pair");
  }
  if (!process.stdout.isTTY && !opts.json) throw new Error("sikrets pair needs a terminal to show the QR code");

  const session = beginPairing(relayUrl());
  const qr = await QRCode.toString(session.qrText, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  process.stderr.write(`\n${qr}\x1b[0m\n`);
  say("Scan this with the Sikrets app (Pair tab). Waiting for your phone…");

  const deadline = Date.now() + RELAY.pairTimeoutMs;
  while (Date.now() < deadline) {
    const pairing = await session.poll().catch(() => undefined);
    if (pairing) {
      if (opts.json) return console.log(JSON.stringify({ paired: true, phone: pairing.phoneName, pairedAt: pairing.pairedAt }));
      return say(`Paired with ${pairing.phoneName}. Approval requests now reach it: sikrets approvals watch`);
    }
    await Bun.sleep(RELAY.pollMs);
  }
  throw new Error("No phone answered in time. Run sikrets pair again.");
}
