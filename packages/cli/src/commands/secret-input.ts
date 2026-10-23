import { Secret } from "../core/secret.ts";
import { promptHidden } from "../ui.ts";

/** Agents pipe a credential with --value-stdin; people get a hidden prompt. Never a CLI argument. */
export async function readSecretInput(opts: Record<string, unknown>, prompt: string): Promise<Secret> {
  if (opts["value-stdin"]) return Secret.of((await Bun.stdin.text()).trim());
  if (!process.stdin.isTTY) throw new Error("No terminal to ask in; pipe the value with --value-stdin");
  return Secret.of(await promptHidden(prompt));
}
