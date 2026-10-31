import "./globals.css"
import type { Metadata, Viewport } from "next"
import { DM_Sans, Geist_Mono, Instrument_Serif } from "next/font/google"
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
    "credential management",
    "secrets management",
    "API key rotation",
    "AI agent security",
    "non-human identities",
    "MCP server credentials",
    "time-limited access",
    "agent sessions",
    "credential proxy",
    "sandboxed AI agents",
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

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500"],
})

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
