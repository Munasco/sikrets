/** Progress goes to stderr so `--json` output on stdout stays machine-readable for agents. */
export function log(opts: { json?: boolean }, message: string) {
  if (!opts.json) console.error(message);
}

/** Reads a line from the terminal without echoing it. */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("No terminal to prompt in; use --password-stdin");
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled")));
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      fn();
    };
    stdin.on("data", onData);
  });
}
