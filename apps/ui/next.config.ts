import path from "path"
import type { NextConfig } from "next"

const securityHeaders = [
  // Prevent the page from being embedded in an iframe (clickjacking)
  { key: "X-Frame-Options", value: "DENY" },
  // Stop browsers from MIME-sniffing a response away from the declared content-type
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send a strict referrer only for same-origin requests
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable features that canette does not use
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
]

const config: NextConfig = {
  // Required when node_modules lives at the monorepo root rather than apps/ui.
  // Tells Turbopack where to find Next.js itself.
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]
  },

  images: {
    // Allowlist the OAuth provider avatar CDNs so next/image can optimise them.
    // Only add origins that are actually used; never use a wildcard hostname here.
    remotePatterns: [
      // GitHub avatars
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      // Google (OAuth profile pictures)
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
}

export default config
