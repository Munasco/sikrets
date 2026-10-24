import path from "node:path";
import { readJson, writeJson } from "./fs.ts";
import { FILES, PROJECT_DIR } from "../constants.ts";

// Project state lives in <project>/.sikrets/ and holds no secret values, so it can be committed.
// state.json  — resources Sikrets has provisioned for this project (drives `cost`, `env pull`)
// journal.json — every add, step by step, with how to undo each step (drives `rollback`)

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
  createdAt: string;
  lastRotatedAt?: string;
  /** Rotate before this time (from rotateEvery, pulled earlier by expiresAt). */
  rotateBy?: string;
  /** When the key itself stops working, if the provider set an expiry. */
  expiresAt?: string;
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

const dir = (root: string) => path.join(root, PROJECT_DIR);

export const projectName = (root: string) => path.basename(path.resolve(root));

export const state = {
  load: (root: string) => readJson<{ version: 1; resources: Resource[] }>(path.join(dir(root), FILES.state), { version: 1, resources: [] }),
  async upsert(root: string, resource: Resource) {
    const s = await state.load(root);
    s.resources = s.resources.filter((r) => r.name !== resource.name).concat(resource);
    await writeJson(path.join(dir(root), FILES.state), s);
  },
  async remove(root: string, name: string) {
    const s = await state.load(root);
    s.resources = s.resources.filter((r) => r.name !== name);
    await writeJson(path.join(dir(root), FILES.state), s);
  },
};

export const journal = {
  load: (root: string) => readJson<Operation[]>(path.join(dir(root), FILES.journal), []),
  save: (root: string, ops: Operation[]) => writeJson(path.join(dir(root), FILES.journal), ops),
  /** Appends each step as soon as it succeeds, so a crash mid-add still leaves a complete undo record. */
  async record(root: string, op: Operation) {
    const ops = (await journal.load(root)).filter((o) => o.id !== op.id).concat(op);
    await journal.save(root, ops);
  },
};
