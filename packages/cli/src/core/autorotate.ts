import path from "node:path";
import { FILES, PROJECT_DIR } from "../constants.ts";
import { autoRotateDue } from "./schedule.ts";
import { state } from "./state.ts";

/**
 * Rotates keys that have auto-rotate on and are due, before a command runs. Only API keys can
 * have auto-rotate, so this never needs a person. A failure is reported and the command goes on
 * with the current key; a later command resumes or retries (see autoRotateDue for the back-off).
 */
export async function autoRotate(root: string, say: (m: string) => void): Promise<void> {
  if (!(await Bun.file(path.join(root, PROJECT_DIR, FILES.state)).exists())) return;
  const { projectContext } = await import("./config.ts");
  const project = await projectContext(root, { dryRun: false, log: () => {} });
  // SIKRETS_VAULT pointing elsewhere is for one-off local runs; rotating then would revoke a key the
  // team shares and keep its replacement only in that other vault.
  if (project.ctx.vault !== project.config.vault) return;
  const every = project.config.rotateEvery;
  const due = autoRotateDue((await state.load(root)).resources, every);
  if (!due.length) return;
  const { rotateOne } = await import("../commands/rotate.ts");
  for (const res of due) {
    try {
      // Re-checked under the rotation lock: another process may have just rotated it.
      const result = await rotateOne(res.name, project, { yes: true }, () => {}, (fresh) => autoRotateDue([fresh], every).length > 0);
      if (result.rotated) say(`sikrets: auto-rotated ${res.name}`);
    } catch (e) {
      say(`sikrets: couldn't auto-rotate ${res.name} (${e instanceof Error ? e.message : String(e)}); will retry later`);
    }
  }
}
