"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "convex/react";
import { formatDistanceToNow } from "@/lib/time";
import { api } from "@/lib/api";
import { projectOf } from "@/lib/vault";
import { slugify } from "@/lib/utils";
import { Frame } from "@/components/frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/spinner";

export default function ProjectsPage() {
  const router = useRouter();
  const secrets = useQuery(api.vault.listSecrets, {});
  const connections = useQuery(api.connectedAccounts.listConnections, {});
  const [name, setName] = useState("");

  // Secret metadata is plaintext, so projects can be listed without unlocking the vault.
  const projects = Object.values(
    (secrets ?? []).reduce<Record<string, { name: string; count: number; envs: Set<string>; updatedAt: string }>>((acc, s) => {
      const p = (acc[projectOf(s)] ??= { name: projectOf(s), count: 0, envs: new Set(), updatedAt: s.updatedAt });
      p.count++;
      p.envs.add(s.environment);
      if (s.updatedAt > p.updatedAt) p.updatedAt = s.updatedAt;
      return acc;
    }, {}),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-12">
      <section className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl text-text">Projects</h1>
            <p className="text-sage">Provision access, connect services, and rotate credentials—all in one place.</p>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const slug = slugify(name);
              if (slug) router.push(`/projects/${slug}`);
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-project" className="h-10 w-56" />
            <Button type="submit" disabled={!slugify(name)}>New project</Button>
          </form>
        </div>

        {secrets === undefined ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : projects.length === 0 ? (
          <Frame className="p-10 text-center space-y-2">
            <p className="text-text">No projects yet</p>
            <p className="text-sm text-muted">Create one above, or run <code className="font-mono text-sage">tennant projects sync</code> in a repo to sync its secrets here.</p>
          </Frame>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.name} href={`/projects/${encodeURIComponent(p.name)}`} className="group bg-surface border-[1.7px] border-line p-5 space-y-4 hover:border-line-strong transition-colors">
                <div className="flex items-center justify-between">
                  <span className="text-lg text-text group-hover:text-white">{p.name}</span>
                  <span className="font-mono text-xs text-muted">{p.count} secret{p.count === 1 ? "" : "s"}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[...p.envs].sort().map((env) => (
                    <span key={env} className="text-xs px-2 py-0.5 border border-line text-label">{env}</span>
                  ))}
                </div>
                <p className="text-xs text-faint">Updated {formatDistanceToNow(p.updatedAt)}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl text-text">Connections</h2>
          <p className="text-sm text-muted">Services linked to this workspace. Manage them in Tennant.</p>
        </div>
        {connections === undefined ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : connections.length === 0 ? (
          <p className="text-sm text-faint">No services connected yet.</p>
        ) : (
          <div className="border-[1.7px] border-line divide-y divide-line">
            {connections.map((c) => (
              <div key={c._id} className="flex items-center justify-between gap-4 px-4 py-3 bg-surface">
                <div className="flex items-center gap-3 min-w-0">
                  {c.providerAvatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.providerAvatarUrl} alt="" className="h-7 w-7 rounded-full" />
                  ) : (
                    <div className="h-7 w-7 rounded-full bg-line" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm text-text capitalize">{c.provider}</p>
                    <p className="text-xs text-muted truncate">{c.providerAccountName}</p>
                  </div>
                </div>
                <span className={c.status === "active" ? "text-xs text-sage" : "text-xs text-danger"}>{c.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
