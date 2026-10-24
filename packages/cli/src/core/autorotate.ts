import path from "node:path";
import { FILES, PROJECT_DIR } from "../constants.ts";
import { autoRotateDue } from "./schedule.ts";
import { state } from "./state.ts";

/**
 * Rotates keys that have auto-rotate on and are due, before a command runs. Only API keys can
 * have auto-rotate, so this never needs a person. A failure is reported and the command goes on
 * with the current key; the next command tries again.
 */
export async function autoRotate(root: string, say: (m: string) => void): Promise<void> {
  if (!(await Bun.file(path.join(root, PROJECT_DIR, FILES.state)).exists())) return;
  const due = autoRotateDue((await state.load(root)).resources);
  if (!due.length) return;
  const { projectContext } = await import("./config.ts");
  const { rotateOne } = await import("../commands/rotate.ts");
  const project = await projectContext(root, { dryRun: false, log: () => {} });
  for (const res of due) {
    try {
      await rotateOne(res, project, { yes: true }, () => {});
      say(`sikrets: auto-rotated ${res.name}`);
    } catch (e) {
      say(`sikrets: couldn't auto-rotate ${res.name} (${e instanceof Error ? e.message : String(e)}); will retry next time`);
    }
  }
}
