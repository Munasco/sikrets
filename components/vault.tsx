"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { createVaultKey, unlockVault } from "@/lib/vault";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Frame } from "./frame";
import { Spinner } from "./spinner";

// The unwrapped master key lives only in memory; reloading the page locks the vault.
const VaultContext = createContext<{ key: CryptoKey | null; setKey: (k: CryptoKey) => void; lock: () => void } | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  return <VaultContext.Provider value={{ key, setKey, lock: () => setKey(null) }}>{children}</VaultContext.Provider>;
}

export function useVault() {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used inside VaultProvider");
  return ctx;
}

// Renders children once the vault is unlocked; otherwise prompts to create or unlock it.
export function VaultGate({ children }: { children: ReactNode }) {
  const vault = useVault();
  const wrapped = useQuery(api.vault.getVaultKey, {});
  const initializeVault = useMutation(api.vault.initializeVault);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  if (vault.key) return <>{children}</>;
  if (wrapped === undefined) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  }

  const isNew = wrapped === null;

  const submit = async () => {
    setBusy(true);
    try {
      if (isNew) {
        if (password !== confirm) throw new Error("Passwords don't match");
        const created = await createVaultKey(password);
        await initializeVault(created);
        vault.setKey(await unlockVault({ _id: "", ...created }, password));
        toast.success("Vault created");
      } else {
        vault.setKey(await unlockVault(wrapped, password));
      }
      setPassword("");
      setConfirm("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unlock vault");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-center px-6 py-16">
      <Frame className="max-w-md w-full p-8 space-y-6">
        <div>
          <h2 className="text-2xl text-text">{isNew ? "Create your vault" : "Unlock your vault"}</h2>
          <p className="text-sm text-sage mt-1">
            {isNew
              ? "Secrets are encrypted in your browser with a key only this password can unlock. Tennant never sees the values."
              : "Enter your vault password to decrypt this workspace's secrets."}
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="vault-password">Vault password</Label>
            <Input
              id="vault-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isNew ? "new-password" : "current-password"}
              autoFocus
            />
          </div>
          {isNew && (
            <div className="space-y-2">
              <Label htmlFor="vault-confirm">Confirm password</Label>
              <Input id="vault-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              <p className="text-xs text-faint">At least 12 characters. If you lose it, these secrets can&apos;t be recovered.</p>
            </div>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !password}>
            {busy && <Spinner />}
            {isNew ? "Create vault" : "Unlock"}
          </Button>
        </form>
      </Frame>
    </div>
  );
}
