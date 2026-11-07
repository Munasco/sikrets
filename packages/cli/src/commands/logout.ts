import { clearSession, deviceClient, readSession, registrationsOf, revokeAll, writeSession } from "../core/device-auth.ts";
import { thisDevice } from "../core/device.ts";
import { log } from "../ui.ts";

// sikrets logout: revokes every registration this device's key holds on the server (earlier
// sign-ins too, not just the current id), then forgets the sign-in. If any revoke fails, the
// sign-in is kept with just those ids, so running logout again finishes the job. The device keys
// stay (they also wrap the vault data key); a later `sikrets login` registers the same key again.

export async function run(_args: string[], opts: Record<string, unknown>) {
  const say = (m: string) => log(opts, m);
  const session = await readSession();
  if (!session) {
    if (opts.json) return console.log(JSON.stringify({ signedIn: false }));
    return say("Not signed in.");
  }
  const client = deviceClient({ server: session.server, device: await thisDevice() });
  // Others first, and the current id only once they're done: after it is revoked, this device
  // can't make another request, so nothing left over could be revoked from here.
  const others = registrationsOf(session).filter((id) => id !== session.deviceId);
  let { failed, errors } = await revokeAll(client, session, others);
  if (!failed.length) ({ failed, errors } = await revokeAll(client, session, [session.deviceId]));
  if (failed.length) {
    await writeSession({ ...session, registrations: [...new Set([...failed, session.deviceId])] });
    if (opts.json) return console.log(JSON.stringify({ signedIn: true, failed }));
    throw new Error(`Couldn't revoke ${failed.join(", ")} on ${session.server} (${errors[0]}). Still signed in; run sikrets logout again, or revoke from another device with: sikrets devices revoke <id>`);
  }
  await clearSession();
  const ids = [...others, session.deviceId];
  if (opts.json) return console.log(JSON.stringify({ signedIn: false, deviceId: session.deviceId, revoked: ids }));
  say(`Signed out. ${ids.join(", ")} ${ids.length > 1 ? "are" : "is"} revoked on ${session.server}.`);
}
