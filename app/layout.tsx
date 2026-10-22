import "./globals.css"
import type { Metadata } from "next"
import { Rethink_Sans, PT_Mono } from "next/font/google"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "Sikrets by Tennant — make stolen keys useless",
  description:
    "Sikrets is a credential broker. Your real API keys stay with Sikrets; your apps get stand-ins that only work from your authorized application.",
  metadataBase: new URL("https://sikrets.usetennant.com"),
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
