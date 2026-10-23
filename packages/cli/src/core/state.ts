import path from "node:path";
import { readJson, writeJson } from "./fs.ts";

// Project state lives in <project>/.sikrets/ and holds no secret values, so it can be committed.
// state.json  — resources Sikrets has provisioned for this project (drives `cost`, `env pull`)
// journal.json — every add, step by step, with how to undo each step (drives `rollback`)

export interface Resource {
  id: string; // "upstash/redis/cache"
  provider: string;
  service: string;
  name: string;
  remoteId: string;
  account: string;
  plan?: string;
  budget?: number;
  envKeys: string[];
  createdAt: string;
}

/** Data-only description of how to reverse a step, so a later process can run it. */
export interface Undo {
  kind: string;
  summary: string;
  data: Record<string, string>;
}

export interface Operation {
  id: string;
  command: string;
  at: string;
  steps: Undo[];
  rolledBackAt?: string;
}

const dir = (root: string) => path.join(root, ".sikrets");

export const projectName = (root: string) => path.basename(path.resolve(root));

export const state = {
  load: (root: string) => readJson<{ version: 1; resources: Resource[] }>(path.join(dir(root), "state.json"), { version: 1, resources: [] }),
  async upsert(root: string, resource: Resource) {
    const s = await state.load(root);
    s.resources = s.resources.filter((r) => r.id !== resource.id).concat(resource);
    await writeJson(path.join(dir(root), "state.json"), s);
  },
  async remove(root: string, id: string) {
    const s = await state.load(root);
    s.resources = s.resources.filter((r) => r.id !== id);
    await writeJson(path.join(dir(root), "state.json"), s);
  },
};

export const journal = {
  load: (root: string) => readJson<Operation[]>(path.join(dir(root), "journal.json"), []),
  save: (root: string, ops: Operation[]) => writeJson(path.join(dir(root), "journal.json"), ops),
  /** Appends each step as soon as it succeeds, so a crash mid-add still leaves a complete undo record. */
  async record(root: string, op: Operation) {
    const ops = (await journal.load(root)).filter((o) => o.id !== op.id).concat(op);
    await journal.save(root, ops);
  },
};
