import { loadConfig } from "../core/config.ts";
import { deviceClient, readSession, writeSession, type Approval } from "../core/device-auth.ts";
import { describeKind, thisDevice } from "../core/device.ts";
import { resolveServer } from "../core/server.ts";
import { log } from "../ui.ts";
import { REVEAL } from "../constants.ts";

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
  const server = await resolveServer(await loadConfig(process.cwd()), typeof opts.server === "string" ? opts.server : undefined);
  const previous = await readSession(server);
  const device = await thisDevice();

  const approve = ({ url, userCode }: Approval) => {
    say(`Approve this device in your browser: ${url}`);
    say(`Check the page shows ${userCode}.`);
    if (!opts["no-browser"]) browser.open(url);
  };
  const session = await deviceClient({ server, device }).login({ approve });
  await writeSession(session);
  // The old registration is replaced; it stays listed (and usable until revoked) on its server.
  if (previous && previous.deviceId !== session.deviceId) say(`Replaced the earlier sign-in (${previous.deviceId}); revoke it with: sikrets devices revoke ${previous.deviceId}`);

  if (opts.json) return console.log(JSON.stringify({ server: session.server, user: session.user, deviceId: session.deviceId, kind: session.kind, hardwareBound: session.hardwareBound }));
  say(`Signed in as ${session.user} on ${session.server}. This device is ${session.deviceId}, with a ${describeKind(session)}.`);
}
