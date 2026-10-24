import { defineManualRecipe } from "./types.ts";
import { PROVIDER_URLS, USER_AGENT } from "../constants.ts";

// Anthropic only issues API keys from the Claude Console, so this recipe asks for one, checks it
// against the API, and keeps it in the vault. Rollback removes it from the vault; revoking the key
// itself happens in the console.
export const apiKey = defineManualRecipe({
  id: "anthropic/api-key",
  provider: "anthropic",
  summary: "An Anthropic API key you create in the Claude Console",
  defaultName: "anthropic",
  inputs: {},
  requires: [],
  outputs: { api_key: { description: "Anthropic API key", env: "API_KEY", sensitive: true } },
  secret: "api_key",
  pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  instructions: {
    url: PROVIDER_URLS.anthropic.keys,
    steps: [
      "Create key → Continue with an API key",
      "Name it after this project, choose an expiry (7 or 30 days pairs well with rotation) and the workspace",
      "Copy the key (it's shown once) and paste it here",
    ],
  },
  estimate: () => "billed per token to your Anthropic account",

  async verify(key) {
    const res = await fetch(`${PROVIDER_URLS.anthropic.api}/v1/models?limit=1`, {
      headers: { "x-api-key": key.reveal(), "anthropic-version": PROVIDER_URLS.anthropic.apiVersion, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) throw new Error("Anthropic rejected this key (401): it's mistyped, revoked or expired");
    if (res.status === 403) throw new Error("Anthropic accepted the key but it lacks permission to list models (403)");
    if (!res.ok) throw new Error(`Couldn't verify the key with Anthropic: HTTP ${res.status}`);
  },
});
