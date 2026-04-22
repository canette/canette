import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import { ErrorBoundary } from "@/components/error-boundary"
import "./globals.css"

export const metadata: Metadata = {
  title: "Canette — Kubernetes Push-to-deploy Platform",
  description: "Deploy apps to Kubernetes without the complexity.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased">
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  )
}
