import path from "node:path";
import {
  AAD,
  MESSAGE_IDS,
  PROTOCOL_VERSION,
  createOffer,
  encodeOffer,
  mailbox,
  openHello,
  relayClient,
  seal,
  sessionKey,
  type CliPairingSecrets,
  type Hello,
  type Offer,
  type RelayClient,
  type UnpairNotice,
} from "@sikrets/pairing";
import { configDir, keychain } from "../store.ts";
import { privateDir, readJson, remove } from "./fs.ts";
import { writeAtomic } from "./lock.ts";
import { ENV, RELAY } from "../constants.ts";

// The laptop's half of phone pairing. The CLI's X25519 secret key and the pairing secret live in
// the OS keychain; ~/.sikrets/pairing.json keeps only public facts (the phone's public keys, the
// relay URL, opaque box ids) so `sikrets pair --status` never needs the keychain.
//
// Each pairing's secrets get their own keychain slot, named by its pairing id, and pairing.json
// names the slot. Re-pairing writes the new slot, then swaps pairing.json in one rename, then drops
// the old slot, so a crash at any point leaves one complete pairing: the old one or the new one.

export interface Pairing {
  relay: string;
  pairingId: string;
  toPhone: string;
  toCli: string;
  phoneEncKey: string;
  phoneSignKey: string;
  phoneName: string;
  pairedAt: string;
}

/** A paired phone, plus what's needed to talk to it. */
export interface Link {
  pairing: Pairing;
  key: Uint8Array;
  relay: RelayClient;
}

export const relayUrl = () => Bun.env[ENV.relay] || RELAY.url;

const file = () => path.join(configDir(), RELAY.pairingFile);

export const loadPairing = () => readJson<Pairing | undefined>(file(), undefined);

/** Pairings saved before per-pairing slots used the fixed account. */
const slotFor = (p: Pick<Pairing, "pairingId">) => `${RELAY.keychainAccount}-${p.pairingId}`;
const slots = (p: Pairing) => [slotFor(p), RELAY.keychainAccount];

async function loadSecrets(p: Pairing): Promise<CliPairingSecrets | undefined> {
  for (const slot of slots(p)) {
    const raw = await keychain.get(RELAY.keychainProvider, slot);
    const secrets = raw ? (JSON.parse(raw) as CliPairingSecrets) : undefined;
    if (secrets && mailbox(secrets.pairSecret).pairingId === p.pairingId) return secrets; // never another pairing's
  }
  return undefined;
}

/** The paired phone and the session key, or undefined when nothing is paired. */
export async function loadLink(fetcher?: typeof fetch): Promise<Link | undefined> {
  const pairing = await loadPairing();
  if (!pairing) return undefined;
  const secrets = await loadSecrets(pairing);
  if (!secrets) throw new Error("This laptop's pairing keys are missing from the keychain. Pair again with: sikrets pair");
  return { pairing, key: sessionKey(secrets.cliSecretKey, pairing.phoneEncKey, secrets.pairSecret), relay: relayClient(pairing.relay, fetcher) };
}

/** Starts a pairing: the QR text to show, and a function that waits for the phone's hello. */
export function beginPairing(relay = relayUrl(), fetcher?: typeof fetch) {
  const { offer, secrets } = createOffer(relay);
  const box = mailbox(secrets.pairSecret);
  const client = relayClient(relay, fetcher);
  return {
    offer,
    qrText: encodeOffer(offer),
    /** One check of the relay; the finished pairing once the phone has said hello. */
    async poll(): Promise<Pairing | undefined> {
      const hello = (await client.list(box.toCli)).find((m) => m.id === MESSAGE_IDS.hello);
      if (!hello) return undefined;
      let h: Hello;
      try {
        h = openHello(secrets.pairSecret, hello.blob);
      } catch {
        return undefined; // not sealed with our secret: ignore it
      }
      const pairing = await finish(offer, secrets, h);
      await client.remove(box.toCli, MESSAGE_IDS.hello);
      return pairing;
    },
  };
}

async function finish(offer: Offer, secrets: CliPairingSecrets, hello: Hello): Promise<Pairing> {
  const box = mailbox(secrets.pairSecret);
  const pairing: Pairing = {
    relay: offer.relay,
    pairingId: box.pairingId,
    toPhone: box.toPhone,
    toCli: box.toCli,
    phoneEncKey: hello.encKey,
    phoneSignKey: hello.signKey,
    phoneName: hello.name.slice(0, 64),
    pairedAt: new Date().toISOString(),
  };
  const previous = await loadPairing();
  await keychain.set(RELAY.keychainProvider, slotFor(pairing), JSON.stringify(secrets));
  await privateDir(configDir());
  await writeAtomic(file(), JSON.stringify(pairing, null, 2) + "\n", 0o600);
  if (previous && previous.pairingId !== pairing.pairingId) for (const slot of slots(previous)) await keychain.delete(RELAY.keychainProvider, slot);
  return pairing;
}

/**
 * Unpairs: tells the phone (best effort, unless the phone is the one that unpaired), removes the
 * record, then the keychain slot. A record without its slot is never left behind.
 */
export async function forgetPairing(opts: { notify?: boolean; fetcher?: typeof fetch } = {}) {
  const pairing = await loadPairing();
  if (!pairing) return;
  if (opts.notify !== false) {
    const link = await loadLink(opts.fetcher).catch(() => undefined);
    const notice: UnpairNotice = { v: PROTOCOL_VERSION, pairingId: pairing.pairingId, at: new Date().toISOString() };
    if (link) await link.relay.put(pairing.toPhone, MESSAGE_IDS.unpaired, seal(link.key, AAD.toPhone, notice), RELAY.snapshotTtlSeconds).catch(() => undefined);
  }
  await remove(file());
  for (const slot of slots(pairing)) await keychain.delete(RELAY.keychainProvider, slot);
}
