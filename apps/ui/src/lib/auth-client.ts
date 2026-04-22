import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  // No baseURL — better-auth uses the current page origin, which Next.js
  // proxies to the API via the /api rewrite in next.config.ts.
})

export const { signIn, signOut, signUp, useSession, changePassword } = authClient
