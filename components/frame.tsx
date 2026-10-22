import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

function Plus({ className }: { className: string }) {
  return (
    <svg className={cn("absolute hidden md:block", className)} width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M10 0V20" stroke="#9CA99A" strokeWidth="1.5" />
      <path d="M0 10L20 10" stroke="#9CA99A" strokeWidth="1.5" />
    </svg>
  )
}

// Tennant's bordered panel with plus marks on each corner.
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative bg-surface border-[1.7px] border-line", className)}>
      <Plus className="-top-2.5 -left-2.5" />
      <Plus className="-top-2.5 -right-2.5" />
      <Plus className="-bottom-2.5 -left-2.5" />
      <Plus className="-bottom-2.5 -right-2.5" />
      {children}
    </div>
  )
}
