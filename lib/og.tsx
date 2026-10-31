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
  const [serif, serifItalic, mono] = await Promise.all([
    fontFile("instrument-serif-latin-400-normal.woff"),
    fontFile("instrument-serif-latin-400-italic.woff"),
    fontFile("geist-mono-latin-400-normal.woff"),
  ])

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          fontFamily: "Instrument Serif",
          color: "#181818",
          background: "linear-gradient(180deg, #dfe4e6 0%, #e8e1da 45%, #cdbfb0 78%, #8d9686 100%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <svg width="40" height="40" viewBox="0 0 20 20" fill="none">
            <rect x="1" y="1" width="18" height="18" stroke="#1c4a40" strokeOpacity="0.45" strokeWidth="1.5" />
            <circle cx="8" cy="10" r="3" stroke="#1c4a40" strokeWidth="1.5" />
            <path d="M11 10H16M14 10V12.5" stroke="#1c4a40" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: 46, letterSpacing: -1 }}>Sikrets</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", color: "#1c4a40", fontSize: 112, lineHeight: 1, letterSpacing: -3 }}>
          <span>Give agents access.</span>
          <span style={{ fontStyle: "italic" }}>Never the keys.</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "Geist Mono", fontSize: 22 }}>
          <div style={{ display: "flex", padding: "14px 20px", borderRadius: 14, background: "rgba(255,255,255,0.92)", border: "1px solid #e5e5e5" }}>
            <span style={{ color: "#948b81" }}>$&nbsp;</span>
            <span>sikrets session run github,slack --for 2h -- claude</span>
          </div>
          <span style={{ color: "#ffffff" }}>{site.url.replace("https://", "")}</span>
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
