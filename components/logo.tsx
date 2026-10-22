export function SikretsMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="1" y="1" width="18" height="18" stroke="#9CA99A" strokeWidth="1.5" />
      <circle cx="8" cy="10" r="3" stroke="#E2E3E0" strokeWidth="1.5" />
      <path d="M11 10H16M14 10V12.5" stroke="#E2E3E0" strokeWidth="1.5" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <SikretsMark />
      <span className="text-xl text-text-soft">Sikrets</span>
      <span className="text-sm text-muted">by Tennant</span>
    </div>
  )
}
