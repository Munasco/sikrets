import { awsClientConfig } from "../providers/aws.ts";
import { registerUndo } from "./plan.ts";
import { Secret } from "./secret.ts";

// Where provisioned credentials live. Until the Sikrets platform vault ships, the default is AWS
// SSM Parameter Store (SecureString, KMS-encrypted, IAM-controlled, shared by everyone on the
// account); the OS keychain is the single-machine fallback. Values only ever cross this boundary
// wrapped in Secret.

export type VaultName = "ssm" | "keychain";

export interface Vault {
  readonly name: VaultName;
  put(key: string, value: Secret): Promise<void>;
  get(key: string): Promise<Secret | undefined>;
  delete(key: string): Promise<void>;
}

const KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const checkKey = (key: string) => {
  if (!KEY.test(key)) throw new Error(`Invalid vault key "${key}"`);
  return key;
};

function keychainVault(project: string): Vault {
  const service = `dev.sikrets.vault.${project}`;
  return {
    name: "keychain",
    put: (key, value) => Bun.secrets.set({ service, name: checkKey(key), value: value.reveal() }),
    get: async (key) => {
      const v = await Bun.secrets.get({ service, name: checkKey(key) });
      return v ? Secret.of(v) : undefined;
    },
    delete: async (key) => void (await Bun.secrets.delete({ service, name: checkKey(key) })),
  };
}

async function ssmVault(project: string): Promise<Vault> {
  const { SSMClient, PutParameterCommand, GetParameterCommand, DeleteParameterCommand, ParameterNotFound } = await import("@aws-sdk/client-ssm");
  const client = new SSMClient(await awsClientConfig());
  const path = (key: string) => `/sikrets/${project}/${checkKey(key)}`;
  return {
    name: "ssm",
    put: async (key, value) =>
      void (await client.send(new PutParameterCommand({ Name: path(key), Value: value.reveal(), Type: "SecureString", Overwrite: true, Tier: "Standard" }))),
    get: async (key) => {
      try {
        const out = await client.send(new GetParameterCommand({ Name: path(key), WithDecryption: true }));
        return out.Parameter?.Value ? Secret.of(out.Parameter.Value) : undefined;
      } catch (error) {
        if (error instanceof ParameterNotFound) return undefined;
        throw error;
      }
    },
    delete: async (key) => {
      try {
        await client.send(new DeleteParameterCommand({ Name: path(key) }));
      } catch (error) {
        if (!(error instanceof ParameterNotFound)) throw error;
      }
    },
  };
}

export function vaultName(): VaultName {
  const chosen = Bun.env.SIKRETS_VAULT ?? "ssm";
  if (chosen !== "ssm" && chosen !== "keychain") throw new Error(`SIKRETS_VAULT must be "ssm" or "keychain", not "${chosen}"`);
  return chosen;
}

export const openVault = async (project: string): Promise<Vault> => (vaultName() === "ssm" ? ssmVault(project) : keychainVault(project));

registerUndo("vault.delete", async ({ project, keys }) => {
  const vault = await openVault(project!);
  for (const key of keys!.split(",")) await vault.delete(key);
});
