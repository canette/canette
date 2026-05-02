"use client"

import { useSession } from "@/lib/auth-client"
import { SessionProvider } from "@/lib/session-context"
import { AppLayout } from "@/components/app-layout"

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

  // Only block render during the very first load (no cached session yet).
  // If isPending but we have existing session data, keep rendering — avoids
  // unmounting the sidebar when better-auth re-validates in the background.
  if (isPending && !session) {
    return null
  }
  if (!session?.user) {
    return null
  }

  return (
    <SessionProvider value={session.user}>
      <AppLayout>
        {children}
      </AppLayout>
    </SessionProvider>
  )
}
