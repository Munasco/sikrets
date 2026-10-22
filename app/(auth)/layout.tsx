"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import Topbar from "@/components/topbar";
import { VaultProvider } from "@/components/vault";
import { Wordmark } from "@/components/logo";
import { Spinner } from "@/components/spinner";

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && !session) router.push("/sign-in");
  }, [session, isPending, router]);

  if (isPending) {
    return (
      <div className="min-h-screen">
        <div className="absolute top-6 left-6">
          <Wordmark />
        </div>
        <div className="flex flex-col items-center justify-center h-screen gap-6">
          <Spinner className="h-8 w-8" />
          <p className="text-lg text-text-soft">Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) return null;

  return (
    <VaultProvider>
      <div className="min-h-screen">
        <Topbar />
        <main className="flex-1">{children}</main>
      </div>
    </VaultProvider>
  );
}
