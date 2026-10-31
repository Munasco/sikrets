/** The Sikrets mark, drawn in the current text colour so it works on paper and on dark panels. */
export function SikretsMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="1" y="1" width="18" height="18" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" />
      <circle cx="8" cy="10" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 10H16M14 10V12.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <SikretsMark />
      <span className="font-serif text-xl">Sikrets</span>
      <span className="text-sm text-muted">by Tennant</span>
    </div>
  )
}
