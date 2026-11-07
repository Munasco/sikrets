import type { Page } from "playwright-core";

export interface Credentials {
  email: string;
  password: string;
}

/** Each flow narrates its steps so anyone watching the terminal can follow along with the browser. */
export type Step = (label: string) => void;

export interface Provider {
  id: string;
  name: string;
  loginUrl: string;
  /** True once the page shows the signed-in app rather than a login screen. */
  isLoggedIn: (page: Page) => Promise<boolean>;
  /** Types the credentials into the provider's own login screens, one human-paced step at a time. */
  login: (page: Page, creds: Credentials, step: Step) => Promise<void>;
  /** For API-backed providers: once signed in, create an API key in the dashboard and return it. */
  mint?: {
    readonly key: string;
    /** Where keys are listed and revoked. */
    readonly manageUrl: string;
    /** Creates a key called `name` and returns its value. */
    readonly run: (page: Page, step: Step, name: string) => Promise<string>;
    /** One cheap API call with the new key; throws if the provider rejects it. */
    readonly verify: (account: string, key: string) => Promise<void>;
  };
}
