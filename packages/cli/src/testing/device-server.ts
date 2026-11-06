import { autoApproval, createApp, manualApproval, sqliteStore, type Store } from "../../../server/src/index.ts";
import type { DeviceRecord } from "../../../server/src/store.ts";

// The real Sikrets server (packages/server), in memory, for tests. `startDeviceServer` listens on a
// random localhost port; `inProcessServer` answers without a socket at all (the test preload
// routes the CLI's requests to it). `approve` stands in for the browser approval page.

export interface TestServer {
  url: string;
  store: Store;
  /** Approves a pending sign-in by its user code, as `user`. */
  approve(userCode: string, user?: string): Promise<void>;
  devices(user?: string): Promise<DeviceRecord[]>;
  stop(): void;
}

export interface TestServerOptions {
  /** Approve every sign-in as this account straight away. */
  autoApprove?: string;
  now?: () => number;
}

export const DEFAULT_USER = "you@localhost";

function build(opts: TestServerOptions) {
  const store = sqliteStore();
  const app = createApp({ store, approval: opts.autoApprove ? autoApproval(opts.autoApprove) : manualApproval(), now: opts.now });
  const approve = async (code: string, user = DEFAULT_USER) => {
    const signIn = await store.findSignInByCode(code);
    if (!signIn) throw new Error(`No pending sign-in with code ${code}`);
    await store.putSignIn({ ...signIn, approvedBy: user });
  };
  return { store, app, approve, devices: (user = DEFAULT_USER) => store.listDevices(user) };
}

export function startDeviceServer(opts: TestServerOptions = {}): TestServer {
  const { store, app, approve, devices } = build(opts);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    store,
    approve,
    devices,
    stop() {
      server.stop(true);
      store.close();
    },
  };
}

/** No socket: `fetch` hands requests straight to the app. */
export function inProcessServer(url: string, opts: TestServerOptions = {}): TestServer & { fetch: (input: string, init: RequestInit) => Promise<Response> } {
  const { store, app, approve, devices } = build(opts);
  return { url, store, approve, devices, fetch: async (input, init) => app.fetch(new Request(input, init)), stop: () => store.close() };
}
