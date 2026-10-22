import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "h-12 w-full min-w-0 rounded-none border-[1.7px] border-line bg-field px-3 text-text placeholder:text-faint outline-none transition-colors focus:ring-1 focus:ring-[#2E322D] disabled:opacity-60",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
