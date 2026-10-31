import { Secret } from "../secret.ts";
import { service } from "./services.ts";
import { PROXY } from "../../constants.ts";

// Real tokens for proxied services, in the OS keychain. Only the proxy reads them; agents in a
// session are sandboxed away from the keychain.

export const tokens = {
  set: (id: string, value: Secret) => Bun.secrets.set({ service: PROXY.keychainService, name: service(id).id, value: value.reveal() }),
  get: async (id: string) => {
    const v = await Bun.secrets.get({ service: PROXY.keychainService, name: service(id).id });
    return v ? Secret.of(v) : undefined;
  },
  delete: (id: string) => Bun.secrets.delete({ service: PROXY.keychainService, name: service(id).id }),
};
