import { shield } from "./redact.ts";
import { scan } from "./patterns.ts";

// How long redaction takes per message: `bun run bench`. Every chat message goes through shield()
// (the prompt hook) and again inside each model request (the context hook), so it has to stay well
// under a millisecond for a typical message.

// Fake values shaped like real keys, assembled at runtime so no scanner mistakes this file for a leak.
const STRIPE = "sk" + "_live_" + "51Hx9fakeFAKEfake0123456789abcdef";
const GITHUB = "ghp" + "_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const PROSE =
  "I think one of our keys leaked last week. We rotated the database password already but I'm not sure about the payment provider. " +
  "Can you tell me what to check first, and whether the old key still shows up in our git history? The repo is private but a contractor had access.";

const CASES: Record<string, string> = {
  "prose, no secret (300 B)": PROSE,
  "typical message with a key (500 B)": `${PROSE}\nHere's the line from our .env: STRIPE_SECRET_KEY=${STRIPE}`,
  "pasted config (4 KB)": Array.from({ length: 40 }, (_, i) => (i === 20 ? `GITHUB_TOKEN=${GITHUB}` : `SETTING_${i}=value-${i} # a comment about setting ${i} and why it is set`)).join("\n").padEnd(4000, " "),
  "largest message (60 KB)": `${PROSE}\n`.repeat(200) + `token: ${GITHUB}`,
};

const time = (fn: () => unknown, minMs = 300) => {
  for (let i = 0; i < 20; i++) fn();
  let n = 0;
  const start = performance.now();
  while (performance.now() - start < minMs) {
    fn();
    n++;
  }
  return (performance.now() - start) / n;
};

const fmt = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`);

console.log("| Input | shield() | scan() |\n|---|---|---|");
for (const [name, text] of Object.entries(CASES)) {
  console.log(`| ${name} | ${fmt(time(() => shield(text)))} | ${fmt(time(() => scan(text)))} |`);
}
