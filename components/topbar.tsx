"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Logout01Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { authClient } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SikretsMark } from "./logo";
import { useVault } from "./vault";

const navigation = [
  { name: "Projects", href: "/projects" },
];

export default function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const workspace = useQuery(api.workspace.getCurrentWorkspace, {});
  const vault = useVault();

  const signOut = async () => {
    vault.lock();
    await authClient.signOut();
    router.push("/sign-in");
  };

  return (
    <div className="sticky top-0 z-50 bg-surface border-b border-line-strong px-6 pt-4 flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <a href={process.env.NEXT_PUBLIC_TENNANT_URL} className="text-xl text-text-soft hover:text-text">Tennant</a>
          <span className="text-sm text-muted">/</span>
          <Link href="/projects" className="flex items-center gap-2">
            <SikretsMark size={16} />
            <span className="text-sm text-text">Sikrets</span>
          </Link>
          {workspace && (
            <>
              <span className="text-sm text-muted">/</span>
              <span className="text-sm text-muted truncate">{workspace.workspaceUrl}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {vault.key && (
            <button onClick={vault.lock} className="flex items-center gap-2 text-xs text-muted hover:text-text px-2 py-1 border border-line">
              <HugeiconsIcon icon={SquareLock02Icon} className="h-4 w-4" />
              Lock vault
            </button>
          )}
          <div className="h-9 w-9 rounded-full bg-line flex items-center justify-center text-sm text-text" title={session?.user?.email}>
            {(session?.user?.name || "U").charAt(0).toUpperCase()}
          </div>
          <button onClick={signOut} className="text-muted hover:text-text" aria-label="Sign out">
            <HugeiconsIcon icon={Logout01Icon} className="h-5 w-5" />
          </button>
        </div>
      </div>
      <nav className="flex items-center space-x-1">
        {navigation.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "px-2 py-2 text-sm transition-colors",
                isActive ? "border-b-3 border-text font-medium" : "text-muted hover:text-text hover:bg-hover",
              )}
            >
              {item.name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
