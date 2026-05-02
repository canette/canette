"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, Plus } from "lucide-react"
import { Footer } from "@/components/footer"
import { Sidebar } from "@/components/sidebar"
import { UserMenu } from "@/components/user-menu"
import { Breadcrumb } from "@/components/breadcrumb"
import { Button } from "@/components/ui/button"
import { TeamProvider } from "@/lib/team-context"

function headerAction(pathname: string): { label: string; href: string } | null {
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return { label: "New project", href: "/dashboard/projects/new" }
  }
  const projectMatch = pathname.match(/\/dashboard\/projects\/([^/]+)$/)
  if (projectMatch && projectMatch[1] !== "new") {
    return { label: "New app", href: `/dashboard/projects/${projectMatch[1]}/apps/new` }
  }
  return null
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()
  const action = headerAction(pathname)

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed")
    if (stored === "true") setCollapsed(true)
  }, [])

  function toggle() {
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem("sidebar-collapsed", String(next))
      return next
    })
  }

  return (
    <TeamProvider>
    <div className="h-screen flex w-full overflow-hidden">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 border-b border-border flex items-center gap-3 px-4 shrink-0">
          {collapsed && (
            <button
              type="button"
              onClick={toggle}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              aria-label="Open sidebar"
            >
              <Menu size={18} />
            </button>
          )}
          <Breadcrumb />
          <div className="ml-auto flex items-center gap-3">
            {action && (
              <Button variant="outline" size="sm" asChild
                className="text-muted-foreground hover:text-foreground gap-1.5">
                <Link href={action.href}>
                  <Plus size={14} />
                  {action.label}
                </Link>
              </Button>
            )}
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="min-h-full flex flex-col px-6 py-8">
            <div className="flex-1">{children}</div>
            {pathname.startsWith("/admin") && <Footer />}
          </div>
        </main>
      </div>
    </div>
    </TeamProvider>
  )
}
