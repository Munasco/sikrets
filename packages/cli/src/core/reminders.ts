import path from "node:path";
import { FILES, PROJECT_DIR } from "../constants.ts";
import { describeDue, dueList } from "./schedule.ts";
import { state } from "./state.ts";

/** One-line nudges about keys that are expired, overdue, or due within a week. Empty when all is well. */
export async function reminders(root: string, now = Date.now()): Promise<string[]> {
  if (!(await Bun.file(path.join(root, PROJECT_DIR, FILES.state)).exists())) return [];
  const due = dueList((await state.load(root)).resources, now);
  if (!due.length) return [];
  return [`! ${due.length} key${due.length === 1 ? "" : "s"} need${due.length === 1 ? "s" : ""} attention:`, ...due.map((d) => `  ${describeDue(d, now)}`), "  Run: sikrets rotate --due"];
}
