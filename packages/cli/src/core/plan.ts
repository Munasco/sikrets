import type { VaultName } from "./vault.ts";
import { journal, markStep, newOperation, transition, type Operation, type Step, type Undo } from "./state.ts";

export interface Context {
  root: string;
  project: string;
  vault: VaultName;
  dryRun: boolean;
  log: (message: string) => void;
}

/**
 * One change `add` will make. `apply` returns how to reverse it, or null if there is nothing to
 * undo. A change with an outside side effect calls `intend` first, so the undo is journaled
 * (as pending) before the side effect starts and a crash or Ctrl-C mid-call still leaves a record.
 */
export interface Change {
  summary: string;
  cost?: string;
  apply: (ctx: Context, intend: (undo: Undo) => Promise<void>) => Promise<Undo | null>;
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
 * already succeeded (or may have) are undone in reverse, so a failed add leaves nothing behind.
 */
export async function applyPlan(command: string, changes: Change[], ctx: Context): Promise<Operation> {
  const op = newOperation(command);
  try {
    for (const change of changes) {
      ctx.log(`  … ${change.summary}`);
      let step: Step | undefined;
      const intend = async (undo: Undo) => {
        step = { ...undo, status: "pending" };
        op.steps.push(step);
        await journal.record(ctx.root, op);
      };
      const undo = await change.apply(ctx, intend);
      if (undo) {
        if (!step) op.steps.push((step = { ...undo, status: "pending" }));
        else Object.assign(step, undo);
        markStep(step, "done");
        await journal.record(ctx.root, op);
      }
    }
    transition(op, "applied");
    await journal.record(ctx.root, op);
    return op;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log(`Failed: ${message}. Undoing ${op.steps.length} step(s).`);
    try {
      await undoSteps(op, ctx);
    } catch (undoError) {
      // Keep both: the cause, and that cleanup is unfinished (the journal says where it stopped).
      throw new Error(`${message}. Undoing it also failed (${undoError instanceof Error ? undoError.message : String(undoError)}); finish with: sikrets rollback ${op.id}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Reverses an operation's steps, newest first, saving progress after each one. Steps already
 * undone are skipped, so a rollback that stopped midway resumes where it left off. Every handler
 * must be idempotent: a pending step may never have happened.
 */
export async function undoSteps(op: Operation, ctx: Context) {
  const todo = [...op.steps].reverse().filter((s) => s.status !== "undone");
  for (const step of todo) if (!undoHandlers.has(step.kind)) throw new Error(`No undo handler for ${step.kind}`);
  if (ctx.dryRun) {
    for (const step of todo) ctx.log(`  - ${step.summary}`);
    return;
  }
  transition(op, "rolling-back");
  await journal.record(ctx.root, op);
  for (const step of todo) {
    ctx.log(`  - ${step.summary}`);
    await undoHandlers.get(step.kind)!(step.data, ctx);
    markStep(step, "undone");
    await journal.record(ctx.root, op);
  }
  transition(op, "rolled-back");
  await journal.record(ctx.root, op);
}
