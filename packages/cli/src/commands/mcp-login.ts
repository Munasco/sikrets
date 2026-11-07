import { connectAgentBrowser, signIn, type AgentBrowser } from "../browser/login.ts";
import { macApprover } from "../core/logins/approve.ts";
import { authorize, type Approver } from "../core/logins/grants.ts";
import type { AgentIdentity } from "../core/logins/identity.ts";
import { getLogin, listLogins, type Login } from "../core/logins/store.ts";
import { LOGINS } from "../constants.ts";

// The MCP `login` tool: "sign the browser in to <site>". The agent names a stored login; Sikrets
// asks the person the first time this agent uses it, fills the agent's browser, and answers only
// "signed in" or why not. The password, the code and the username never enter the protocol.

export const LOGIN_TOOL = {
  name: "login",
  title: "Sign in to a website",
  description:
    "Sign the shared browser in to a website with a login the user stored in Sikrets. Open the site's sign-in page first; " +
    "Sikrets fills the username, password and 2FA code itself and tells you whether it worked. You never see the credentials. " +
    "Call with no site to list the logins you can use.",
  inputSchema: {
    type: "object",
    properties: { site: { type: "string", description: "Login name, e.g. \"github\" (see the list from calling with no site)" } },
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, openWorldHint: true },
} as const;

export interface LoginToolOptions {
  /** DevTools endpoint of the agent's Chrome. */
  browser?: string;
  /** Injected for tests; default to the keychain, the macOS prompt and a real Chrome. */
  getLogin?: (name: string) => Promise<Login | undefined>;
  listLogins?: () => Promise<{ name: string; origin: string }[]>;
  approve?: Approver;
  connect?: (endpoint: string) => Promise<AgentBrowser>;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

// One sign-in at a time per browser, across every server in this process (each HTTP client has
// its own): two fills interleaved on one page would mix logins.
const signInQueue = new Map<string, Promise<unknown>>();
export function oneAtATime<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
  const next = (signInQueue.get(endpoint) ?? Promise.resolve()).then(fn);
  const settled = next.catch(() => undefined);
  signInQueue.set(endpoint, settled);
  void settled.then(() => signInQueue.get(endpoint) === settled && signInQueue.delete(endpoint));
  return next;
}

export function createLoginTool(opts: LoginToolOptions) {
  const endpoint = opts.browser ?? Bun.env[LOGINS.cdpEnv] ?? LOGINS.defaultCdp;
  const connect = opts.connect ?? connectAgentBrowser;
  let browser: Promise<AgentBrowser> | undefined;
  // One connection per server. Once Chrome goes away (closed, crashed) the old connection is let
  // go and a new one is made on the next call.
  const agentBrowser = async () => {
    const current = browser;
    if (current) {
      const b = await current.catch(() => undefined);
      if (b?.connected()) return b;
      if (browser === current) browser = undefined;
      await b?.close();
    }
    browser ??= connect(endpoint);
    return browser.catch((e) => {
      browser = undefined;
      throw e;
    });
  };

  /** Lets go of the browser connection (the server is shutting down). */
  const release = async () => {
    const b = await browser?.catch(() => undefined);
    browser = undefined;
    await b?.close();
  };

  async function login(args: Record<string, unknown>, agent: AgentIdentity | { name: string }) {
    const site = typeof args.site === "string" ? args.site.trim() : "";
    if (!site) {
      const all = await (opts.listLogins ?? listLogins)();
      return text(all.length ? all.map((l) => `${l.name}  ${l.origin}`).join("\n") : "No logins stored. The user can add one with: sikrets logins add <name> <url>");
    }
    const stored = await (opts.getLogin ?? getLogin)(site);
    if (!stored) return text(`No login named "${site}". Call login with no site to see what's available.`, true);

    const { allowed } = await authorize(stored.name, stored.origin, agent, opts.approve ?? macApprover);
    if (!allowed) return text(`The user didn't allow ${agent.name} to use ${stored.name}.`, true);

    const result = await oneAtATime(endpoint, async () => signIn(await agentBrowser(), stored));
    if (result.status === "signed-in") return text(`Signed in to ${stored.name} (${stored.origin}).`);
    if (result.status === "unverified")
      return text(`Submitted the sign-in for ${stored.name}, but the site moved to ${result.at}, so Sikrets couldn't confirm it worked. Check the page before relying on it.`);
    return text(result.error, true);
  }

  return Object.assign(login, { release });
}
