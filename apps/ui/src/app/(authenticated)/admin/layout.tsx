"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import { Skeleton } from "@/components/ui/skeleton"

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { data: session, isPending: sessionLoading } = useSession()

  useEffect(() => {
    if (sessionLoading) return
    const u = session?.user as Record<string, unknown> | undefined
    const role = typeof u?.role === "string" ? u.role : undefined
    if (role !== "admin") router.replace("/dashboard")
  }, [session, sessionLoading, router])

  if (sessionLoading) return <div className="flex flex-col gap-3 p-6"><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-40" /></div>

  return <>{children}</>
}
