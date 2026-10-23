import { journal, type Operation, type Undo } from "./state.ts";

export interface Context {
  root: string;
  project: string;
  dryRun: boolean;
  log: (message: string) => void;
}

/** One change `add` will make. `apply` returns how to reverse it, or null if there is nothing to undo. */
export interface Change {
  summary: string;
  cost?: string;
  apply: (ctx: Context) => Promise<Undo | null>;
}

export type UndoHandler = (data: Record<string, string>, ctx: Context) => Promise<void>;
const undoHandlers = new Map<string, UndoHandler>();
export const registerUndo = (kind: string, handler: UndoHandler) => undoHandlers.set(kind, handler);

export function printPlan(changes: Change[], ctx: Context) {
  ctx.log(ctx.dryRun ? "Dry run — nothing will be created:" : "Plan:");
  for (const c of changes) ctx.log(`  + ${c.summary}${c.cost ? `  (${c.cost})` : ""}`);
}

/**
 * Applies changes in order, journaling each undo as it lands. If any step fails, the steps that
 * already succeeded are undone in reverse, so a failed add leaves nothing behind.
 */
export async function applyPlan(command: string, changes: Change[], ctx: Context): Promise<Operation> {
  const op: Operation = { id: `op_${Date.now().toString(36)}`, command, at: new Date().toISOString(), steps: [] };
  try {
    for (const change of changes) {
      ctx.log(`  … ${change.summary}`);
      const undo = await change.apply(ctx);
      if (undo) {
        op.steps.push(undo);
        await journal.record(ctx.root, op);
      }
    }
    return op;
  } catch (error) {
    ctx.log(`Failed: ${error instanceof Error ? error.message : String(error)}. Undoing ${op.steps.length} completed step(s).`);
    await undoSteps(op, ctx);
    op.rolledBackAt = new Date().toISOString();
    await journal.record(ctx.root, op);
    throw error;
  }
}

export async function undoSteps(op: Operation, ctx: Context) {
  for (const step of [...op.steps].reverse()) {
    const handler = undoHandlers.get(step.kind);
    if (!handler) throw new Error(`No undo handler for ${step.kind}`);
    ctx.log(`  - ${step.summary}`);
    if (!ctx.dryRun) await handler(step.data, ctx);
  }
}
