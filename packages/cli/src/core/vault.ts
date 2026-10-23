import { registerUndo } from "./plan.ts";

// Provisioned credentials, kept in the OS keychain per project. Moves to the Tennant vault later.
const service = (project: string) => `dev.sikrets.vault.${project}`;

export const vault = {
  set: (project: string, key: string, value: string) => Bun.secrets.set({ service: service(project), name: key, value }),
  get: (project: string, key: string) => Bun.secrets.get({ service: service(project), name: key }),
  delete: (project: string, key: string) => Bun.secrets.delete({ service: service(project), name: key }),
};

registerUndo("vault.delete", async ({ project, keys }) => {
  for (const key of keys!.split(",")) await vault.delete(project!, key);
});
