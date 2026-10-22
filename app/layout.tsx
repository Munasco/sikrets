import "./globals.css"
import type { Metadata } from "next"
import { Rethink_Sans, PT_Mono } from "next/font/google"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import { ConvexClientProvider } from "./ConvexClientProvider"

export const metadata: Metadata = {
  title: "Sikrets by Tennant",
  description: "A home for your projects' secrets and connections. Provision access, connect services, and rotate credentials—all in one place.",
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
      <body className={`${rethinkSans.variable} ${ptMono.variable}`}>
        <ConvexClientProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" />
        </ConvexClientProvider>
      </body>
    </html>
  )
}
