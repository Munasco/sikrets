import { getRandomValues } from "expo-crypto";

// The crypto module draws randomness from globalThis.crypto.getRandomValues, which Hermes doesn't
// provide everywhere. expo-crypto's is backed by the OS CSPRNG.
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") g.crypto.getRandomValues = getRandomValues;
