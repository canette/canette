import { createAuthClient } from "better-auth/react"
import { adminClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  // No baseURL — better-auth uses the current page origin, which Next.js
  // proxies to the API via the /api rewrite in next.config.ts.
  plugins: [adminClient()],
})

export const { signIn, signOut, signUp, useSession, changePassword } = authClient
