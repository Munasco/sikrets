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
}
