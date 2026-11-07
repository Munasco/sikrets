import { toProcessEnv, type Env } from "../core/credentials.ts";

// How short-lived credentials reach whatever needs them: as a child process environment
// (`… -- <command>`, like `sikrets run`), or as `export` lines for `eval "$(…)"`. Export lines go to
// stdout only when it isn't a terminal, so they land in a shell variable, never on screen.

const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

export const exportLines = (env: Env) =>
  Object.entries(toProcessEnv(env))
    .map(([k, v]) => `export ${k}=${quote(v)}`)
    .join("\n");

/** What will receive the credentials, for the usage log; checked before anything is issued. */
export function recipient(command: string[], opts: Record<string, unknown>, usage: string): string {
  // Only the program name, not its arguments, which could contain anything.
  if (command.length) return command[0]!.split("/").at(-1)!;
  if (!opts.env) throw new Error(`Say where the credentials go: ${usage} -- <command>, or eval "$(${usage} --env)"`);
  if (process.stdout.isTTY) throw new Error(`Refusing to print credentials to a terminal. Use: eval "$(${usage} --env)"`);
  return "env export";
}

export async function deliver(env: Env, command: string[]) {
  if (!command.length) return console.log(exportLines(env));
  const proc = Bun.spawn(command, { env: { ...Bun.env, ...toProcessEnv(env) }, stdio: ["inherit", "inherit", "inherit"] });
  process.exitCode = await proc.exited;
}
