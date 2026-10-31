import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ImageResponse } from "next/og"
import { site } from "@/lib/site"

// Shared social card for opengraph-image and twitter-image. Fonts are bundled in assets/fonts so
// the image renders at build time and on Vercel without fetching from Google Fonts.

export const ogSize = { width: 1200, height: 630 }
export const ogAlt = `${site.name} — ${site.tagline}`

const fontFile = (name: string) => readFile(join(process.cwd(), "assets/fonts", name))

export async function renderOg() {
  const [serif, serifItalic, mono, photo] = await Promise.all([
    fontFile("instrument-serif-latin-400-normal.woff"),
    fontFile("instrument-serif-latin-400-italic.woff"),
    fontFile("geist-mono-latin-400-normal.woff"),
    readFile(join(process.cwd(), "public/landing/hero.jpg")),
  ])
  const photoSrc = `data:image/jpeg;base64,${photo.toString("base64")}`

  const forest = "#1f3b2d"
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", fontFamily: "Instrument Serif", color: forest, background: "#ffffff", padding: 18 }}>
        <div style={{ position: "relative", display: "flex", width: "100%", height: "100%", borderRadius: 20, overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoSrc} alt="" width={1164} height={594} style={{ position: "absolute", inset: 0, width: 1164, height: 594, objectFit: "cover", objectPosition: "center 70%" }} />
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", width: "100%", height: "100%", paddingTop: 48 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <svg width="32" height="32" viewBox="0 0 24 24">
                <path fill={forest} fillRule="evenodd" d="M4 22V10.5a8 8 0 0 1 16 0V22zM12 9.2a2.2 2.2 0 0 0-1.1 4.1L10.4 18h3.2l-.5-4.7A2.2 2.2 0 0 0 12 9.2z" />
              </svg>
              <span style={{ fontSize: 38, letterSpacing: -1 }}>Sikrets</span>
            </div>
            <div style={{ display: "flex", marginTop: 44, fontSize: 104, lineHeight: 1, letterSpacing: -3 }}>Your virtual security guard.</div>
            <div style={{ display: "flex", marginTop: 26, fontFamily: "Geist Mono", fontSize: 22, color: "#3d4540" }}>The AI agent you can paste keys into.</div>
          </div>
        </div>
      </div>
    ),
    {
      ...ogSize,
      fonts: [
        { name: "Instrument Serif", data: serif, weight: 400, style: "normal" },
        { name: "Instrument Serif", data: serifItalic, weight: 400, style: "italic" },
        { name: "Geist Mono", data: mono, weight: 400, style: "normal" },
      ],
    },
  )
}
