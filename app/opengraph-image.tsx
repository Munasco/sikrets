import { ogAlt, ogSize, renderOg } from "@/lib/og"

export const alt = ogAlt
export const size = ogSize
export const contentType = "image/png"

export default function OpengraphImage() {
  return renderOg()
}
