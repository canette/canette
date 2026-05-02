"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "@/lib/auth-client"

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { data: session, isPending: sessionLoading } = useSession()

  useEffect(() => {
    if (sessionLoading) return
    const u = session?.user as Record<string, unknown> | undefined
    const role = typeof u?.role === "string" ? u.role : undefined
    if (role !== "admin") router.replace("/dashboard")
  }, [session, sessionLoading, router])

  if (sessionLoading) return <p className="text-muted-foreground text-sm">Loading…</p>

  return <>{children}</>
}
