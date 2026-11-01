import { connectAgentBrowser, signIn, type AgentBrowser } from "../browser/login.ts";
import { macApprover } from "../core/logins/approve.ts";
import { authorize, type Approver } from "../core/logins/grants.ts";
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

export function createLoginTool(opts: LoginToolOptions) {
  const endpoint = opts.browser ?? Bun.env[LOGINS.cdpEnv] ?? LOGINS.defaultCdp;
  let browser: Promise<AgentBrowser> | undefined;
  // One connection per server; a closed browser is reconnected on the next call.
  const agentBrowser = async () => {
    browser ??= (opts.connect ?? connectAgentBrowser)(endpoint);
    const b = await browser.catch((e) => {
      browser = undefined;
      throw e;
    });
    if (b.pages().length) return b;
    browser = undefined;
    return (browser = (opts.connect ?? connectAgentBrowser)(endpoint));
  };

  return async function login(args: Record<string, unknown>, agent: string) {
    const site = typeof args.site === "string" ? args.site.trim() : "";
    if (!site) {
      const all = await (opts.listLogins ?? listLogins)();
      return text(all.length ? all.map((l) => `${l.name}  ${l.origin}`).join("\n") : "No logins stored. The user can add one with: sikrets logins add <name> <url>");
    }
    const stored = await (opts.getLogin ?? getLogin)(site);
    if (!stored) return text(`No login named "${site}". Call login with no site to see what's available.`, true);

    const { allowed } = await authorize(stored.name, stored.origin, agent, opts.approve ?? macApprover);
    if (!allowed) return text(`The user didn't allow ${agent} to use ${stored.name}.`, true);

    const result = await signIn(await agentBrowser(), stored);
    return result.ok ? text(`Signed in to ${stored.name} (${stored.origin}).`) : text(result.error, true);
  };
}
