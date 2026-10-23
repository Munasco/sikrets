import "./globals.css"
import type { Metadata, Viewport } from "next"
import { Rethink_Sans, PT_Mono } from "next/font/google"
import type { ReactNode } from "react"
import { site } from "@/lib/site"

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
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
    "automatic secret rotation",
    "AI agent security",
    "non-human identities",
    "MCP server credentials",
    "dynamic secrets",
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
  themeColor: "#0c0e0d",
  colorScheme: "dark",
}

const rethinkSans = Rethink_Sans({
  variable: "--font-rethink-sans",
  subsets: ["latin"],
})

const ptMono = PT_Mono({
  variable: "--font-pt-mono",
  subsets: ["latin"],
  weight: "400",
})

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${rethinkSans.variable} ${ptMono.variable}`}>{children}</body>
    </html>
  )
}
