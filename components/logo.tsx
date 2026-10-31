/** The Sikrets mark (an arched door with a keyhole), drawn in the current text colour so it works on paper and on dark panels. */
export function SikretsMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" fillRule="evenodd" d="M4 22V10.5a8 8 0 0 1 16 0V22zM12 9.2a2.2 2.2 0 0 0-1.1 4.1L10.4 18h3.2l-.5-4.7A2.2 2.2 0 0 0 12 9.2z" />
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
