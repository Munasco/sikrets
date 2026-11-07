import path from "node:path";
import { readJson, withLock, writeJson } from "./fs.ts";
import type { VaultName } from "./vault.ts";
import { FILES, PROJECT_DIR } from "../constants.ts";

// Project state lives in <project>/.sikrets/ and holds no secret values, so it can be committed.
// state.json  — resources Sikrets has provisioned for this project (drives `cost`, `env pull`)
// journal.json — every add, step by step, with how to undo each step (drives `rollback`)
// Both are only changed under a cross-process lock and replaced atomically.

export interface Resource {
  /** Unique within the project; also the Terraform module name and env var prefix. */
  name: string;
  recipe: `${string}/${string}`;
  provider: string;
  strategy: "api" | "terraform" | "manual";
  /** Provider-side id, for API resources (what destroy/cost/rotate address). */
  remoteId?: string;
  inputs: Record<string, string | number>;
  /** Requirement name → resource name it is satisfied by. */
  dependsOn: Record<string, string>;
  /** Vault keys this resource publishes once applied. */
  envKeys: string[];
  /** Non-sensitive outputs (ids, URLs) from the last sync. Sensitive ones live only in the vault. */
  outputs: Record<string, string>;
  applied: boolean;
  /** Vault its values were stored in (SIKRETS_VAULT can differ from sikrets.json). Older files: the project's vault. */
  vault?: VaultName;
  createdAt: string;
  lastRotatedAt?: string;
  /** Rotate before this time (from rotateEvery, pulled earlier by expiresAt). */
  rotateBy?: string;
  /** Lifetime chosen at creation (e.g. "30d"); each rotation gets the same unless told otherwise. */
  expires?: string;
  /** When the current key stops working. */
  expiresAt?: string;
  /** Rotate automatically when due (API keys only). */
  autoRotate?: boolean;
  /** A rotation that started and hasn't finished; see commands/rotate.ts. */
  rotation?: Rotation;
  /** Manual recipes: the key a rotation replaced, until the person confirms it was revoked. */
  oldKey?: { hint: string; replacedAt: string };
}

/**
 * requested: the provider was asked for a new credential (the old one may already be dead), and
 *            nothing durable holds the new one yet. Recovery: rotate again.
 * issued:    the new credential is saved in the local recovery keychain but not yet in the vault.
 *            Recovery: copy it into the vault.
 */
export interface Rotation {
  status: "requested" | "issued";
  at: string;
  /** issued: which recipe outputs are held in the recovery keychain. */
  outputs?: string[];
}

/** Data-only description of how to reverse a step, so a later process can run it. */
export interface Undo {
  kind: string;
  summary: string;
  data: Record<string, string>;
}

/**
 * pending: recorded before the change ran; it may or may not have happened, so undo is idempotent.
 * done:    the change happened.
 * undone:  reversed; a resumed rollback skips it.
 */
export type StepStatus = "pending" | "done" | "undone";
export interface Step extends Undo {
  status: StepStatus;
}

/**
 * running → applied            the command finished
 * running | applied → rolling-back → rolled-back
 * rolling-back → rolling-back  a rollback that stopped midway is resumed
 */
export type OperationStatus = "running" | "applied" | "rolling-back" | "rolled-back";
export interface Operation {
  id: string;
  command: string;
  at: string;
  status: OperationStatus;
  steps: Step[];
  rolledBackAt?: string;
}

const NEXT: Record<OperationStatus, readonly OperationStatus[]> = {
  running: ["applied", "rolling-back"],
  applied: ["rolling-back"],
  "rolling-back": ["rolling-back", "rolled-back"],
  "rolled-back": [],
};
const STEP_NEXT: Record<StepStatus, readonly StepStatus[]> = { pending: ["done", "undone"], done: ["undone"], undone: [] };

/** The only way an operation changes status; refuses moves the lifecycle doesn't allow. */
export function transition(op: Operation, to: OperationStatus) {
  if (!NEXT[op.status].includes(to)) throw new Error(`${op.id} is ${op.status}; it can't become ${to}`);
  op.status = to;
  if (to === "rolled-back") op.rolledBackAt = new Date().toISOString();
}

export function markStep(step: Step, to: StepStatus) {
  if (!STEP_NEXT[step.status].includes(to)) throw new Error(`Step "${step.summary}" is ${step.status}; it can't become ${to}`);
  step.status = to;
}

export const newOperation = (command: string): Operation => ({
  id: `op_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`,
  command,
  at: new Date().toISOString(),
  status: "running",
  steps: [],
});

/** Journals written before statuses existed: a rolledBackAt means everything was undone. */
function normalize(op: Operation): Operation {
  const status: OperationStatus = op.status ?? (op.rolledBackAt ? "rolled-back" : "applied");
  const steps = op.steps.map((s): Step => ({ ...s, status: s.status ?? (status === "rolled-back" ? "undone" : "done") }));
  return { ...op, status, steps };
}

/** Which project a state file belongs to; set on first write, checked on every write after. */
export interface Owner {
  root: string;
  project: string;
}

interface StateFile {
  version: 1;
  project?: string;
  resources: Resource[];
}

const dir = (root: string) => path.join(root, PROJECT_DIR);
const stateFile = (root: string) => path.join(dir(root), FILES.state);
const journalFile = (root: string) => path.join(dir(root), FILES.journal);

export const projectName = (root: string) => path.basename(path.resolve(root));

/** Refuses to use state recorded for a different project name (a renamed folder, a changed sikrets.json). */
export function assertOwner(recorded: string | undefined, project: string) {
  if (recorded !== undefined && recorded !== project) {
    throw new Error(
      `.sikrets/state.json belongs to project "${recorded}", but this directory is now project "${project}", so its values would be looked up in the wrong place. Set "project": "${recorded}" in sikrets.json`,
    );
  }
}

export const state = {
  load: (root: string) => readJson<StateFile>(stateFile(root), { version: 1, resources: [] }),
  /** Read-modify-write of the resource list under the state lock. */
  async update(at: Owner, change: (resources: Resource[]) => Resource[]) {
    await withLock(stateFile(at.root), async () => {
      const s = await state.load(at.root);
      assertOwner(s.project, at.project);
      await writeJson(stateFile(at.root), { ...s, project: at.project, resources: change(s.resources) });
    });
  },
  upsert: (at: Owner, resource: Resource) => state.update(at, (rs) => rs.filter((r) => r.name !== resource.name).concat(resource)),
  remove: (at: Owner, name: string) => state.update(at, (rs) => rs.filter((r) => r.name !== name)),
  /** Changes one resource as it is now on disk, not as a caller read it earlier. */
  async patch(at: Owner, name: string, change: (r: Resource) => Resource) {
    await state.update(at, (rs) => {
      const i = rs.findIndex((r) => r.name === name);
      if (i < 0) throw new Error(`"${name}" is no longer in .sikrets/state.json`);
      return rs.with(i, change(rs[i]!));
    });
  },
};

export const journal = {
  load: async (root: string) => (await readJson<Operation[]>(journalFile(root), [])).map(normalize),
  /** Saves one operation (replacing its previous version) under the journal lock. */
  async record(root: string, op: Operation) {
    await withLock(journalFile(root), async () => {
      const ops = (await journal.load(root)).filter((o) => o.id !== op.id).concat(op);
      await writeJson(journalFile(root), ops);
    });
  },
};
