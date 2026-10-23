import { ImageResponse } from "next/og"

export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0c0e0d" }}>
        <svg width="120" height="120" viewBox="0 0 20 20" fill="none">
          <rect x="1" y="1" width="18" height="18" stroke="#9CA99A" strokeWidth="1.5" />
          <circle cx="8" cy="10" r="3" stroke="#E2E3E0" strokeWidth="1.5" />
          <path d="M11 10H16M14 10V12.5" stroke="#E2E3E0" strokeWidth="1.5" />
        </svg>
      </div>
    ),
    size,
  )
}
