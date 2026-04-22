"use client"

import { useSession } from "@/lib/auth-client"

// The middleware already redirects unauthenticated requests to /login before
// they reach this layout. The session check here is a client-side UX guard:
// it hides content while the session is being resolved and handles the edge
// case where a session cookie exists but is expired (the API will return 401,
// the useSession hook will clear the session, and window.location.replace in
// api.ts will finish the redirect).
export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { isPending, data: session } = useSession()

  if (isPending || !session?.user) return null

  return <>{children}</>
}
