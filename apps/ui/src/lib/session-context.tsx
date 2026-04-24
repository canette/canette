"use client"

import { createContext, useContext } from "react"
import { useSession } from "@/lib/auth-client"

// Derive the user type directly from the hook so it stays in sync with better-auth.
type UseSessionData = NonNullable<ReturnType<typeof useSession>["data"]>
export type SessionUser = UseSessionData["user"]

const SessionContext = createContext<SessionUser | null>(null)

export const SessionProvider = SessionContext.Provider

/** Returns the authenticated user. Only call inside the authenticated layout tree. */
export function useCurrentUser(): SessionUser {
  const user = useContext(SessionContext)
  if (!user) throw new Error("useCurrentUser called outside authenticated layout")
  return user
}
