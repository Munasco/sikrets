import { ImageResponse } from "next/og"

export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1f3b2d" }}>
        <svg width="112" height="112" viewBox="0 0 24 24">
          <path fill="#eef3ea" fillRule="evenodd" d="M4 22V10.5a8 8 0 0 1 16 0V22zM12 9.2a2.2 2.2 0 0 0-1.1 4.1L10.4 18h3.2l-.5-4.7A2.2 2.2 0 0 0 12 9.2z" />
        </svg>
      </div>
    ),
    size,
  )
}
