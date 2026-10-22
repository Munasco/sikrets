export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return <div className={`${className} animate-spin rounded-full border-2 border-sage border-t-transparent`} />
}
