import { clearSession, deviceClient, readSession } from "../core/device-auth.ts";
import { thisDevice } from "../core/device.ts";
import { log } from "../ui.ts";

// sikrets logout: revokes this device on the server, then forgets the sign-in. The device keys stay
// (they also wrap the vault data key); a later `sikrets login` registers the same key again.

export async function run(_args: string[], opts: Record<string, unknown>) {
  const say = (m: string) => log(opts, m);
  const session = await readSession();
  if (!session) {
    if (opts.json) return console.log(JSON.stringify({ signedIn: false }));
    return say("Not signed in.");
  }
  let revoked = true;
  try {
    await deviceClient({ server: session.server, device: await thisDevice() }).revoke(session, session.deviceId);
  } catch (error) {
    revoked = false;
    say(`Couldn't revoke ${session.deviceId} on ${session.server} (${error instanceof Error ? error.message : String(error)}). Signed out here anyway; revoke it from another device with: sikrets devices revoke ${session.deviceId}`);
  }
  await clearSession();
  if (opts.json) return console.log(JSON.stringify({ signedIn: false, deviceId: session.deviceId, revoked }));
  if (revoked) say(`Signed out. ${session.deviceId} is revoked on ${session.server}.`);
}
