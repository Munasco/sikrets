import { loadConfig } from "../core/config.ts";
import { DeviceAuthError, deviceClient, readSession, revokeStale, rotateDeviceKeys, writeSession, type Approval } from "../core/device-auth.ts";
import { describeKind, thisDevice } from "../core/device.ts";
import { chooseServer } from "../core/server.ts";
import { log } from "../ui.ts";
import { DEVICE_AUTH, REVEAL } from "../constants.ts";

// sikrets login: registers this device's signing key with the Sikrets server. A person approves
// the sign-in in the browser; after that every request is signed by this device's key, so there
// is no token on disk worth stealing. No Touch ID: the device key works without user presence.
// The server signed in to becomes this profile's saved server (see core/server.ts for the order).

/** Opens the approval page when a person is plainly at this Mac; tests replace it. */
export const browser = {
  open(url: string) {
    if (process.platform !== "darwin" || !process.stderr.isTTY || Bun.env[REVEAL.ciEnv]) return;
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  },
};

export async function run(_args: string[], opts: Record<string, unknown>) {
  const say = (m: string) => log(opts, m);
  const { url: server, source } = await chooseServer(await loadConfig(process.cwd()), typeof opts.server === "string" ? opts.server : undefined);
  // A server named by this project's sikrets.json is signed in to for this project only: it
  // doesn't become the saved server every other project uses.
  const remember = source !== "project";
  const previous = await readSession(server);
  const device = await thisDevice();

  const approve = ({ url, userCode }: Approval) => {
    say(`Approve this device in your browser: ${url}`);
    say(`Check the page shows ${userCode}.`);
    if (!opts["no-browser"]) browser.open(url);
  };
  let client = deviceClient({ server, device });
  let fresh;
  try {
    fresh = await client.login({ approve });
  } catch (error) {
    if (!(error instanceof DeviceAuthError && error.reason === DEVICE_AUTH.keyRevoked)) throw error;
    // This key was revoked (a logout, or from another device) and the server won't take it again.
    say("This device's key was revoked on that server, so it gets new keys (your data key is re-wrapped to them).");
    client = deviceClient({ server, device: await rotateDeviceKeys() });
    fresh = await client.login({ approve });
  }
  await writeSession(fresh, { remember }); // signed in, whatever happens next
  // This key's earlier sign-ins on this server (and ones left by replaced keys) are revoked now,
  // so the key isn't still accepted under an old id. Any that fail are kept, for logout or next login.
  const session = await revokeStale(client, fresh, previous);
  await writeSession(session, { remember });
  const left = (session.registrations ?? []).filter((id) => id !== session.deviceId);
  if (left.length) say(`Couldn't revoke the earlier sign-in${left.length > 1 ? "s" : ""} ${left.join(", ")}; sikrets logout will try again.`);

  if (opts.json) return console.log(JSON.stringify({ server: session.server, user: session.user, deviceId: session.deviceId, kind: session.kind, hardwareBound: session.hardwareBound }));
  say(`Signed in as ${session.user} on ${session.server}. This device is ${session.deviceId}, with a ${describeKind(session)}.`);
}
