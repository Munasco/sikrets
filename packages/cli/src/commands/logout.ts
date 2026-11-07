import { loadConfig } from "../core/config.ts";
import { clearSession, deviceClient, readSession, revokeAll } from "../core/device-auth.ts";
import { thisDevice } from "../core/device.ts";
import { resolveServer } from "../core/server.ts";
import { log } from "../ui.ts";

// sikrets logout: revokes this device's key on the server, which revokes every sign-in made with
// it (earlier ones too) and refuses the key from then on; then forgets the sign-in. If the revoke
// fails, the sign-in is kept, so running logout again finishes the job. The device keys stay
// (they also wrap the vault data key); the next `sikrets login` makes new ones, since the server
// won't take this key again.

export async function run(_args: string[], opts: Record<string, unknown>) {
  const say = (m: string) => log(opts, m);
  const session = await readSession(await resolveServer(await loadConfig(process.cwd())));
  if (!session) {
    if (opts.json) return console.log(JSON.stringify({ signedIn: false }));
    return say("Not signed in.");
  }
  const client = deviceClient({ server: session.server, device: await thisDevice() });
  const { failed, errors } = await revokeAll(client, session, [session.deviceId]);
  if (failed.length) {
    if (opts.json) return console.log(JSON.stringify({ signedIn: true, failed }));
    throw new Error(`Couldn't revoke ${session.deviceId} on ${session.server} (${errors[0]}). Still signed in; run sikrets logout again, or revoke it from another device with: sikrets devices revoke ${session.deviceId}`);
  }
  await clearSession(session.server);
  if (opts.json) return console.log(JSON.stringify({ signedIn: false, deviceId: session.deviceId, revoked: [session.deviceId] }));
  say(`Signed out. ${session.deviceId} and this device's key are revoked on ${session.server}.`);
}
