import { makeFunctionReference } from "convex/server";

// Typed references into the shared Tennant Convex backend (@tennantcloud/convex).
// Swap these for the package's generated `api` once GitHub Packages auth is set up.

export type VaultKey = {
  _id: string;
  wrappedMasterKey: string;
  kekSalt: string;
  kekIterations: number;
  algorithm: string;
};

export type VaultSecret = {
  _id: string;
  provider: string;
  product?: string;
  environment: string;
  key: string;
  encryptedValue: string;
  iv: string;
  description?: string;
  sensitive: boolean;
  updatedAt: string;
  version: number;
};

export type Connection = {
  _id: string;
  provider: string;
  providerAccountName: string;
  providerAvatarUrl?: string;
  status: "active" | "expired" | "revoked";
  connectedAt: string;
  lastUsedAt?: string;
};

export type Workspace = { _id: string; workspaceUrl: string; plan: string };

export const api = {
  workspace: {
    getCurrentWorkspace: makeFunctionReference<"query", Record<string, never>, Workspace | null>(
      "workspace/queries:getCurrentWorkspace",
    ),
  },
  vault: {
    getVaultKey: makeFunctionReference<"query", Record<string, never>, VaultKey | null>("vault:getVaultKey"),
    initializeVault: makeFunctionReference<
      "mutation",
      { wrappedMasterKey: string; kekSalt: string; kekIterations: number; algorithm: string },
      { id: string }
    >("vault:initializeVault"),
    listSecrets: makeFunctionReference<"query", { environment?: string; provider?: string }, VaultSecret[]>(
      "vault:listSecrets",
    ),
    storeSecret: makeFunctionReference<
      "mutation",
      {
        provider: string;
        product?: string;
        environment: string;
        key: string;
        encryptedValue: string;
        iv: string;
        description?: string;
        sensitive: boolean;
      },
      { id: string; version: number; created: boolean }
    >("vault:storeSecret"),
    deleteSecret: makeFunctionReference<"mutation", { secretId: string }, { success: boolean }>(
      "vault:deleteSecret",
    ),
  },
  connectedAccounts: {
    listConnections: makeFunctionReference<"query", { provider?: string }, Connection[]>(
      "connectedAccounts:listConnections",
    ),
  },
};
