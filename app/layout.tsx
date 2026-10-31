import "./globals.css"
import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import type { ReactNode } from "react"
import { metadataOrigin, site } from "@/lib/site"

export const metadata: Metadata = {
  metadataBase: new URL(metadataOrigin),
  title: { default: site.title, template: `%s — ${site.name}` },
  description: site.description,
  applicationName: site.name,
  authors: [{ name: "Tennant", url: site.tennantUrl }],
  creator: "Tennant",
  publisher: "Tennant",
  keywords: [
    "virtual security guard",
    "autonomous security agent",
    "AI security",
    "secrets management",
    "API key rotation",
    "AI agent security",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: site.url,
    siteName: site.name,
    title: site.title,
    description: site.description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: site.twitter,
    title: site.title,
    description: site.description,
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
}

// Fonts are bundled so builds never depend on reaching Google Fonts.
const dmSans = localFont({
  variable: "--font-dm-sans",
  src: [{ path: "./fonts/DMSans.woff2", weight: "400 500", style: "normal" }],
})

const instrumentSerif = localFont({
  variable: "--font-instrument-serif",
  src: [
    { path: "./fonts/InstrumentSerif.woff2", weight: "400", style: "normal" },
    { path: "./fonts/InstrumentSerif-Italic.woff2", weight: "400", style: "italic" },
  ],
})

const geistMono = localFont({
  variable: "--font-geist-mono",
  src: [{ path: "./fonts/GeistMono.woff2", weight: "400 500", style: "normal" }],
})

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${dmSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`}>
        <noscript>
          <style>{`.reveal{opacity:1;transform:none}`}</style>
        </noscript>
        {children}
      </body>
    </html>
  )
}
