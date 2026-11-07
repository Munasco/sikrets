import { checkAppKey } from "../core/github-app.ts";
import { defineManualRecipe } from "./types.ts";
import { GITHUB } from "../constants.ts";

// A GitHub App's private key. It never leaves the vault: `sikrets github token` uses it to mint
// one-hour installation tokens. The check is local (the key must parse as RSA); the first token
// request is the live check, since it needs the app and installation ids too.
export const appKey = defineManualRecipe({
  id: "github/app-key",
  provider: "github",
  summary: "A GitHub App private key, for minting one-hour installation tokens",
  defaultName: "github-app",
  inputs: {
    app_id: { kind: "string", description: "The App's numeric id (App settings → About)", default: "", pattern: /^\d+$/ },
    installation_id: { kind: "string", description: "Installation id (the number at the end of the installation's settings URL)", default: "", pattern: /^\d+$/ },
  },
  requires: [],
  outputs: { private_key: { description: "GitHub App private key (.pem)", env: "PRIVATE_KEY", sensitive: true } },
  secret: "private_key",
  pattern: /^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----$/,
  instructions: {
    url: GITHUB.appSettings,
    steps: [
      "Open the App → General → Private keys → Generate a private key (a .pem downloads)",
      "Pass it on stdin: sikrets add github/app-key --set app_id=<id> --set installation_id=<id> --value-stdin < key.pem",
      "Delete the downloaded .pem once it's stored",
    ],
  },
  estimate: () => "free",
  verify: async (key) => checkAppKey(key),
});
