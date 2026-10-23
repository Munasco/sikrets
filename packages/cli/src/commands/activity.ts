import { readActivity } from "../core/activity.ts";

// Recent activity in this project, newest last. Key names only; values are never logged.
export async function run(_args: string[], opts: Record<string, unknown>) {
  const limit = typeof opts.limit === "string" ? Math.max(1, Number(opts.limit) || 20) : 20;
  const entries = (await readActivity(process.cwd())).slice(-limit);
  if (opts.json) return console.log(JSON.stringify(entries));
  if (!entries.length) return console.log("No activity yet.");
  for (const e of entries) {
    const when = e.at.replace("T", " ").slice(0, 19);
    const keys = e.keys?.length ? `  [${e.keys.join(", ")}]` : "";
    const real = e.kind === "env.pull" ? (e.real ? "  REAL values" : "  stand-ins") : "";
    console.log(`${when}  ${e.user.padEnd(12)} ${e.kind.padEnd(9)} ${e.detail}${real}${keys}`);
  }
}
