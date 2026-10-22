"use client"

import { useEffect, useState } from "react"

// Cycles through words in place; the headline itself "rotates", echoing what Sikrets does to keys.
export function RotatingWord({ words, interval = 2200 }: { words: string[]; interval?: number }) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const id = setInterval(() => setIndex((i) => (i + 1) % words.length), interval)
    return () => clearInterval(id)
  }, [words.length, interval])

  return (
    <span className="relative inline-grid align-bottom text-sage" aria-live="polite">
      {/* Reserve the width of the longest word so the line doesn't reflow */}
      {words.map((word, i) => (
        <span
          key={word}
          aria-hidden={i !== index}
          className={`col-start-1 row-start-1 transition-all duration-500 ease-out ${
            i === index ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"
          }`}
        >
          {word}
        </span>
      ))}
    </span>
  )
}
