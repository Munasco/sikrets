import { DEVICE, ENV } from "../constants.ts";

// Loaded before every test file (bunfig.toml). The real Secure Enclave is only used by the opt-in
// smoke test, which builds its own backend.
process.env[ENV.deviceKeys] = DEVICE.forceSoftware;
