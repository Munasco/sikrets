import path from "node:path";
import {
  MESSAGE_IDS,
  createOffer,
  encodeOffer,
  mailbox,
  openHello,
  relayClient,
  sessionKey,
  type CliPairingSecrets,
  type Hello,
  type Offer,
  type RelayClient,
} from "@sikrets/pairing";
import { configDir, keychain } from "../store.ts";
import { readJson, remove, writePrivate } from "./fs.ts";
import { ENV, RELAY } from "../constants.ts";

// The laptop's half of phone pairing. The CLI's X25519 secret key and the pairing secret live in
// the OS keychain; ~/.sikrets/pairing.json keeps only public facts (the phone's public keys, the
// relay URL, opaque box ids) so `sikrets pair --status` never needs the keychain.

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

async function loadSecrets(): Promise<CliPairingSecrets | undefined> {
  const raw = await keychain.get(RELAY.keychainProvider, RELAY.keychainAccount);
  return raw ? (JSON.parse(raw) as CliPairingSecrets) : undefined;
}

/** The paired phone and the session key, or undefined when nothing is paired. */
export async function loadLink(fetcher?: typeof fetch): Promise<Link | undefined> {
  const pairing = await loadPairing();
  if (!pairing) return undefined;
  const secrets = await loadSecrets();
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
  await keychain.set(RELAY.keychainProvider, RELAY.keychainAccount, JSON.stringify(secrets));
  await writePrivate(file(), JSON.stringify(pairing, null, 2) + "\n");
  return pairing;
}

export async function forgetPairing() {
  await keychain.delete(RELAY.keychainProvider, RELAY.keychainAccount).catch(() => undefined);
  await remove(file());
}
