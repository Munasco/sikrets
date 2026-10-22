"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, Copy01Icon, Delete02Icon, ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { api, type VaultSecret } from "@/lib/api";
import { decryptValue, encryptValue, projectOf } from "@/lib/vault";
import { formatDistanceToNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useVault, VaultGate } from "@/components/vault";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Frame } from "@/components/frame";
import { Spinner } from "@/components/spinner";

const ENVIRONMENTS = ["development", "staging", "production"];

export default function ProjectPage({ params }: { params: Promise<{ project: string }> }) {
  const project = decodeURIComponent(use(params).project);
  const [environment, setEnvironment] = useState("development");
  const all = useQuery(api.vault.listSecrets, {});
  const secrets = (all ?? []).filter((s) => projectOf(s) === project && s.environment === environment).sort((a, b) => a.key.localeCompare(b.key));

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-8">
      <div className="space-y-2">
        <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <HugeiconsIcon icon={ArrowLeft01Icon} className="h-4 w-4" /> Projects
        </Link>
        <h1 className="text-3xl text-text">{project}</h1>
      </div>

      <div className="flex gap-1 border-b border-line">
        {ENVIRONMENTS.map((env) => (
          <button
            key={env}
            onClick={() => setEnvironment(env)}
            className={cn("px-3 py-2 text-sm capitalize", env === environment ? "border-b-3 border-text text-text" : "text-muted hover:text-text hover:bg-hover")}
          >
            {env}
          </button>
        ))}
      </div>

      <VaultGate>
        {all === undefined ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (
          <div className="space-y-8">
            <SecretForm project={project} environment={environment} />
            {secrets.length === 0 ? (
              <p className="text-sm text-faint">No secrets in {environment} yet.</p>
            ) : (
              <div className="border-[1.7px] border-line divide-y divide-line">
                {secrets.map((s) => (
                  <SecretRow key={s._id} secret={s} />
                ))}
              </div>
            )}
          </div>
        )}
      </VaultGate>
    </div>
  );
}

function SecretRow({ secret }: { secret: VaultSecret }) {
  const { key } = useVault();
  const deleteSecret = useMutation(api.vault.deleteSecret);
  const [value, setValue] = useState<string | null>(null);

  const reveal = async () => {
    if (value !== null) return setValue(null);
    try {
      setValue(await decryptValue(key!, secret));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not decrypt");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value ?? (await decryptValue(key!, secret)));
      toast.success(`Copied ${secret.key}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not copy");
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${secret.key} from ${secret.environment}?`)) return;
    await deleteSecret({ secretId: secret._id });
    toast.success(`Deleted ${secret.key}`);
  };

  return (
    <div className="flex flex-col md:flex-row md:items-center gap-3 px-4 py-3 bg-surface">
      <div className="md:w-72 min-w-0">
        <p className="font-mono text-sm text-text truncate">{secret.key}</p>
        <p className="text-xs text-faint">
          {secret.provider} · v{secret.version} · {formatDistanceToNow(secret.updatedAt)}
        </p>
      </div>
      <p className="flex-1 font-mono text-sm text-label truncate">{value ?? "••••••••••••••••"}</p>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" onClick={reveal} aria-label={value === null ? "Reveal" : "Hide"}>
          <HugeiconsIcon icon={value === null ? ViewIcon : ViewOffIcon} className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={copy} aria-label="Copy">
          <HugeiconsIcon icon={Copy01Icon} className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete" className="hover:text-danger">
          <HugeiconsIcon icon={Delete02Icon} className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// Adding a key that already exists in this environment rotates it (the backend upserts and bumps the version).
function SecretForm({ project, environment }: { project: string; environment: string }) {
  const { key } = useVault();
  const storeSecret = useMutation(api.vault.storeSecret);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const secretKey = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    const identity = { key: secretKey, environment, provider: "custom" };
    setBusy(true);
    try {
      const encrypted = await encryptValue(key!, identity, value);
      const { created, version } = await storeSecret({ ...identity, ...encrypted, product: project, sensitive: true });
      toast.success(created ? `Added ${secretKey}` : `Rotated ${secretKey} to v${version}`);
      setName("");
      setValue("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save secret");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame className="p-6">
      <form
        className="flex flex-col md:flex-row gap-3 md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2 md:w-72">
          <Label htmlFor="secret-key">Key</Label>
          <Input id="secret-key" value={name} onChange={(e) => setName(e.target.value)} placeholder="DATABASE_URL" className="h-10 font-mono" />
        </div>
        <div className="space-y-2 flex-1">
          <Label htmlFor="secret-value">Value</Label>
          <Input id="secret-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} className="h-10 font-mono" autoComplete="off" />
        </div>
        <Button type="submit" disabled={busy || !name.trim() || !value}>
          {busy && <Spinner className="h-4 w-4" />}
          Save secret
        </Button>
      </form>
    </Frame>
  );
}
