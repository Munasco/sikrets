import { ImageResponse } from "next/og"

export const alt = "Sikrets — Credential management for the agentic era"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

async function font(family: string, weight: number) {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`).then((r) => r.text())
  const url = css.match(/src: url\((.+?)\) format/)?.[1]
  if (!url) throw new Error(`Font not found: ${family}`)
  return fetch(url).then((r) => r.arrayBuffer())
}

export default async function OpengraphImage() {
  const [sans, mono] = await Promise.all([font("Rethink+Sans", 400), font("PT+Mono", 400)])

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0c0e0d",
          padding: 72,
          fontFamily: "Rethink Sans",
          color: "#e2e3e0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="44" height="44" viewBox="0 0 20 20" fill="none">
            <rect x="1" y="1" width="18" height="18" stroke="#9CA99A" strokeWidth="1.5" />
            <circle cx="8" cy="10" r="3" stroke="#E2E3E0" strokeWidth="1.5" />
            <path d="M11 10H16M14 10V12.5" stroke="#E2E3E0" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: 40, color: "#c9d0c8" }}>Sikrets</span>
          <span style={{ fontSize: 26, color: "#788377" }}>by Tennant</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ fontSize: 76, lineHeight: 1.05, letterSpacing: -2, maxWidth: 1000 }}>Credential management for the agentic era.</div>
          <div style={{ fontSize: 34, color: "#9ca99a" }}>Auto-provisioned, auto-rotated keys for every agent.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "PT Mono", fontSize: 24, color: "#626c60" }}>
          <span>sikrets.usetennant.com</span>
          <span>keeps · provisions · rotates</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Rethink Sans", data: sans, weight: 400 },
        { name: "PT Mono", data: mono, weight: 400 },
      ],
    },
  )
}
