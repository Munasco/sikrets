import Constants, { ExecutionEnvironment } from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { MESSAGE_IDS, PROTOCOL_VERSION, createPhoneIdentity, decodeOffer, mailbox, relayClient, sealHello, type Offer } from "@sikrets/pairing";
import { COPY, STORAGE } from "./constants";

// This phone's keys. The pairing record (laptop public key, pairing secret, this phone's X25519
// key) sits in the keychain, readable while unlocked so the app can decrypt requests. The Ed25519
// signing key is the one that approves; it is stored behind biometrics where the platform allows
// (a standalone build: the keychain item itself requires Face ID). Expo Go can't attach Face ID to
// a keychain item, so there the key is kept device-only and every use is gated by a Face ID check
// through expo-local-authentication first.

export interface StoredPairing {
  offer: Offer;
  encSecretKey: string;
  encPublicKey: string;
  signPublicKey: string;
  pairedAt: string;
  /** True when the signing key's keychain item itself requires Face ID. */
  biometricBound: boolean;
  /** Keychain item holding this pairing's signing key. Absent on older pairings: STORAGE.signKey. */
  signKeySlot?: string;
}

const slotOf = (p: StoredPairing) => p.signKeySlot ?? STORAGE.signKey;

const deviceOnly = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const isExpoGo = () => Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export async function loadPairing(): Promise<StoredPairing | undefined> {
  const raw = await SecureStore.getItemAsync(STORAGE.pairing, deviceOnly);
  return raw ? (JSON.parse(raw) as StoredPairing) : undefined;
}

export async function biometricsReady() {
  return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
}

/**
 * Scanned QR text → keys created, the hello sent to the laptop, then stored. The new signing key goes
 * into a slot of its own, and the previous pairing (record and key) stays untouched until the hello
 * is out: if the relay can't be reached, nothing about the current pairing changes.
 */
export async function pairWith(qrText: string): Promise<StoredPairing> {
  const offer = decodeOffer(qrText);
  if (!(await biometricsReady())) throw new Error("Set up Face ID (or a passcode) first: approvals are signed behind it.");
  const id = createPhoneIdentity();
  const box = mailbox(offer.secret);
  const previous = await loadPairing();
  if (previous?.offer.secret === offer.secret) throw new Error("Already paired with this laptop.");
  const slot = `${STORAGE.signKey}.${box.pairingId.slice(0, 16)}`;
  let biometricBound = false;
  await SecureStore.deleteItemAsync(slot).catch(() => undefined);
  if (!isExpoGo() && SecureStore.canUseBiometricAuthentication()) {
    try {
      await SecureStore.setItemAsync(slot, id.signSecretKey, {
        requireAuthentication: true,
        authenticationPrompt: COPY.faceIdApprove,
        keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      });
      biometricBound = true;
    } catch {
      biometricBound = false;
    }
  }
  if (!biometricBound) await SecureStore.setItemAsync(slot, id.signSecretKey, { keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY });

  const pairing: StoredPairing = { offer, encSecretKey: id.encSecretKey, encPublicKey: id.encPublicKey, signPublicKey: id.signPublicKey, pairedAt: new Date().toISOString(), biometricBound, signKeySlot: slot };
  try {
    await relayClient(offer.relay).put(box.toCli, MESSAGE_IDS.hello, sealHello(offer.secret, { v: PROTOCOL_VERSION, encKey: id.encPublicKey, signKey: id.signPublicKey, name: COPY.phoneName, at: pairing.pairedAt }));
  } catch (error) {
    await SecureStore.deleteItemAsync(slot).catch(() => undefined);
    throw error;
  }
  await SecureStore.setItemAsync(STORAGE.pairing, JSON.stringify(pairing), deviceOnly);
  if (previous && slotOf(previous) !== slot) await SecureStore.deleteItemAsync(slotOf(previous)).catch(() => undefined);
  return pairing;
}

/**
 * Face ID, then the signing key. Undefined when the person cancels. One prompt either way: the
 * keychain's own (biometric-bound) or expo-local-authentication's (Expo Go).
 */
export async function unlockSigningKey(pairing: StoredPairing, prompt: string): Promise<string | undefined> {
  if (pairing.biometricBound) {
    try {
      return (await SecureStore.getItemAsync(slotOf(pairing), { requireAuthentication: true, authenticationPrompt: prompt })) ?? undefined;
    } catch {
      return undefined; // cancelled or failed: treat as no answer
    }
  }
  const auth = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: "Cancel", disableDeviceFallback: false });
  if (!auth.success) return undefined;
  return (await SecureStore.getItemAsync(slotOf(pairing))) ?? undefined;
}

export async function forget() {
  const pairing = await loadPairing();
  if (pairing) await SecureStore.deleteItemAsync(slotOf(pairing)).catch(() => undefined);
  await SecureStore.deleteItemAsync(STORAGE.signKey).catch(() => undefined);
  await SecureStore.deleteItemAsync(STORAGE.sent).catch(() => undefined);
  await SecureStore.deleteItemAsync(STORAGE.pairing, deviceOnly).catch(() => undefined);
  await SecureStore.deleteItemAsync(STORAGE.notified).catch(() => undefined);
}
