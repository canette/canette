"use client"

import { useEffect } from "react"
import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import { AppShell } from "@/components/app-shell"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "Users", href: "/admin/users" },
  { label: "Teams", href: "/admin/teams" },
  { label: "Projects", href: "/admin/projects" },
  { label: "Settings", href: "/admin/settings" },
]

const bottomNavItems = [
  { label: "Reconciliation", href: "/admin/reconciliation" },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { data: session, isPending: sessionLoading } = useSession()

  useEffect(() => {
    if (sessionLoading) return
    const u = session?.user as Record<string, unknown> | undefined
    const role = typeof u?.role === "string" ? u.role : undefined
    if (role !== "admin") router.replace("/dashboard")
  }, [session, sessionLoading, router])

  if (sessionLoading) {
    return (
      <AppShell breadcrumb={[{ label: "Admin" }]}>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </AppShell>
    )
  }

  return (
    <AppShell breadcrumb={[{ label: "Admin" }]} rawMain>
      <div className="max-w-6xl mx-auto w-full px-6 py-8 flex gap-10">
        <aside className="w-44 shrink-0">
          <nav className="flex flex-col gap-0.5">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "text-sm px-3 py-1.5 rounded-md transition-colors",
                  pathname.startsWith(item.href)
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                {item.label}
              </Link>
            ))}
            <div className="border-t border-border mt-3 pt-3 flex flex-col gap-0.5">
              {bottomNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "text-sm px-3 py-1.5 rounded-md transition-colors",
                    pathname.startsWith(item.href)
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        </aside>
        <div className="flex-1 min-w-0">
          {children}
        </div>
      </div>
    </AppShell>
  )
}
