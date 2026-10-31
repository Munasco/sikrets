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
    readFile(join(process.cwd(), "public/landing/hero-key.jpg")),
  ])
  const photoSrc = `data:image/jpeg;base64,${photo.toString("base64")}`

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", fontFamily: "Instrument Serif", color: "#ffffff", background: "#121b22" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photoSrc} alt="" width={1200} height={630} style={{ position: "absolute", inset: 0, width: 1200, height: 630, objectFit: "cover", objectPosition: "72% center" }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", background: "linear-gradient(90deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0) 100%)" }} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "64px 72px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="40" height="40" viewBox="0 0 20 20" fill="none">
              <rect x="1" y="1" width="18" height="18" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="1.5" />
              <circle cx="8" cy="10" r="3" stroke="#ffffff" strokeWidth="1.5" />
              <path d="M11 10H16M14 10V12.5" stroke="#ffffff" strokeWidth="1.5" />
            </svg>
            <span style={{ fontSize: 46, letterSpacing: -1 }}>Sikrets</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", fontSize: 116, lineHeight: 1, letterSpacing: -3 }}>
            <span>Your virtual</span>
            <span style={{ fontStyle: "italic" }}>security guard.</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "Geist Mono", fontSize: 22, color: "rgba(255,255,255,0.75)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 14, height: 14, borderRadius: 7, background: "#7ee2a8" }} />
              <span style={{ letterSpacing: 2 }}>ON DUTY</span>
            </div>
            <span>{site.url.replace("https://", "")}</span>
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
