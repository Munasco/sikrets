import { clearSession, deviceClient, readSession, type DeviceInfo } from "../core/device-auth.ts";
import { describeKind, readDeviceMeta, thisDevice } from "../core/device.ts";
import { log } from "../ui.ts";

// sikrets devices [list|revoke <id>]: this device's key (and whether it is hardware-bound), then
// every device signed in to your account. A revoked device's requests are refused from then on.

export async function run(args: string[], opts: Record<string, unknown>) {
  const [action = "list", id] = args;
  if (action === "list") return list(opts);
  if (action === "revoke") {
    if (!id) throw new Error("Which device? Usage: sikrets devices revoke <id>");
    return revoke(id, opts);
  }
  throw new Error(`Unknown action "${action}". Use: sikrets devices [list] | revoke <id>`);
}

const status = (d: DeviceInfo) => (d.revokedAt ? `revoked ${d.revokedAt.slice(0, 10)}` : "active");

async function list(opts: Record<string, unknown>) {
  const meta = await readDeviceMeta();
  const session = await readSession();
  const here = meta ? { kind: meta.kind, hardwareBound: meta.hardwareBound, description: describeKind(meta) } : undefined;
  const devices = session ? await deviceClient({ server: session.server, device: await thisDevice() }).devices(session) : undefined;

  if (opts.json) return console.log(JSON.stringify({ thisDevice: here ?? null, signedIn: Boolean(session), user: session?.user, server: session?.server, deviceId: session?.deviceId, devices: devices ?? [] }));
  console.log(`This device: ${here ? here.description : "no device key yet (one is created on first use)"}`);
  if (!session || !devices) return console.log("Not signed in. Run: sikrets login");
  console.log(`Signed in as ${session.user} on ${session.server}\n`);
  const w = Math.max(...devices.map((d) => d.id.length), 2) + 2;
  const n = Math.max(...devices.map((d) => d.name.length), 4);
  console.log(`  ${"ID".padEnd(w)}  ${"NAME".padEnd(n)}  ${"KEY".padEnd(34)}  ${"REGISTERED".padEnd(10)}  STATUS`);
  for (const d of devices) {
    const mark = d.id === session.deviceId ? "* " : "  ";
    console.log(`${mark}${d.id.padEnd(w)}  ${d.name.padEnd(n)}  ${describeKind(d).padEnd(34)}  ${d.registeredAt.slice(0, 10)}  ${status(d)}`);
  }
  console.log("\n* this device");
}

async function revoke(id: string, opts: Record<string, unknown>) {
  const session = await readSession();
  if (!session) throw new Error("Not signed in. Run: sikrets login");
  await deviceClient({ server: session.server, device: await thisDevice() }).revoke(session, id);
  if (id === session.deviceId) await clearSession();
  if (opts.json) return console.log(JSON.stringify({ revoked: id }));
  log(opts, id === session.deviceId ? `Revoked ${id}, which is this device. Run sikrets login to sign in again.` : `Revoked ${id}. Its requests are refused from now on.`);
}
