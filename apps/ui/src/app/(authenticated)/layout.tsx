"use client"

import { useSession } from "@/lib/auth-client"
import { SessionProvider } from "@/lib/session-context"

// The middleware already redirects unauthenticated requests to /login before
// they reach this layout. The session check here is a client-side UX guard:
// it hides content while the session is being resolved and handles the edge
// case where a session cookie exists but is expired (the API will return 401,
// the useSession hook will clear the session, and window.location.replace in
// api.ts will finish the redirect).
export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const { isPending, data: session, error } = useSession()

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-sm font-medium">Unable to reach the API</p>
          <p className="text-sm text-muted-foreground">
            The server returned an error while loading your session. This is likely a temporary issue.
          </p>
          <button
            type="button"
            className="text-sm underline underline-offset-2"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }

  if (isPending || !session?.user) {
    return null
  }

  return (
    <SessionProvider value={session.user}>
      {children}
    </SessionProvider>
  )
}
