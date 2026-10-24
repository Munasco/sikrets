import { openai } from "./openai.ts";
import type { Provider } from "./types.ts";
import { upstash } from "./upstash/index.ts";
import { x } from "./x.ts";

export const providers: Record<string, Provider> = { openai, upstash, x };

export function provider(id: string): Provider {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider "${id}". Available: ${Object.keys(providers).join(", ")}`);
  return p;
}
