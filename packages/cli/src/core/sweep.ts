import path from "node:path";
import { withLock } from "./fs.ts";
import { undoSteps, type Context } from "./plan.ts";
import { journal, state } from "./state.ts";
import { FILES, PROJECT_DIR } from "../constants.ts";
// Modules that register the undo kinds a `get` journal can contain.
import "./add.ts";
import "./files.ts";
import "./vault.ts";

/**
 * Deletes resources whose expiresAt has passed by rolling back the operation that created them
 * (provider delete, vault keys, state). A sweep that fails midway is resumed by the next one, since
 * rollback skips steps already undone. Returns the names removed.
 */
export async function sweepExpired(ctx: Context, now = Date.now()): Promise<string[]> {
  return withLock(path.join(ctx.root, PROJECT_DIR, FILES.sweep), async () => {
    const expired = (await state.load(ctx.root)).resources.filter((r) => r.expiresAt && Date.parse(r.expiresAt) <= now).map((r) => r.name);
    if (!expired.length) return [];
    const ops = await journal.load(ctx.root);
    const swept: string[] = [];
    for (const name of expired) {
      const op = ops.filter((o) => o.status !== "rolled-back" && o.steps.some((s) => s.kind === "state.remove" && s.data.name === name)).at(-1);
      if (!op) {
        ctx.log(`${name} expired, but nothing records how it was created; remove it at its provider`);
        continue;
      }
      ctx.log(`${name} expired; deleting it:`);
      try {
        await undoSteps(op, ctx);
        swept.push(name);
      } catch (error) {
        ctx.log(`  couldn't finish (${error instanceof Error ? error.message : String(error)}); the next sikrets get retries`);
      }
    }
    return swept;
  });
}
