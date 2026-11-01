import { manager } from "../managers/index.ts";
import { log } from "../ui.ts";
import { readSecretInput } from "./secret-input.ts";

// `sikrets unlock <manager>` signs in to a password manager's CLI and keeps the session in the OS
// keychain, so link, import and rotate write-back can use it without asking again.
// `sikrets lock <manager>` locks it and forgets the session.
export async function run(args: string[], opts: Record<string, unknown>) {
  const m = manager(args[0]!);
  const say = (s: string) => log(opts, s);
  if (opts.lock) {
    await m.lock();
    if (opts.json) return console.log(JSON.stringify({ manager: m.id, locked: true }));
    return say(`Locked ${m.name}; the session is gone from your keychain.`);
  }
  const account = await m.unlock({
    server: typeof opts.server === "string" ? opts.server : undefined,
    email: typeof opts.email === "string" ? opts.email : undefined,
    password: () => readSecretInput({ "value-stdin": opts["password-stdin"] }, `${m.name} master password: `),
    say,
  });
  if (opts.json) console.log(JSON.stringify({ manager: m.id, account, unlocked: true }));
  else say(`Unlocked ${m.name} as ${account}; session saved to your keychain. Lock again with: sikrets unlock ${args[0]} --lock`);
}
