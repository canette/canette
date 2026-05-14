"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { ChevronDown, Menu, Plus } from "lucide-react"
import { Footer } from "@/components/footer"
import { Sidebar } from "@/components/sidebar"
import { UserMenu } from "@/components/user-menu"
import { Breadcrumb } from "@/components/breadcrumb"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { TeamProvider } from "@/lib/team-context"

type HeaderAction = {
  label: string
  href: string
  dropdownItems?: Array<{ label: string; href: string }>
}

function headerAction(pathname: string): HeaderAction | null {
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    return { label: "New project", href: "/dashboard/projects/new" }
  }
  const projectMatch = pathname.match(/\/dashboard\/projects\/([^/]+)/)
  if (projectMatch && projectMatch[1] !== "new") {
    const slug = projectMatch[1]
    return {
      label: "New app",
      href: `/dashboard/projects/${slug}/apps/new`,
      dropdownItems: [{ label: "From template", href: `/dashboard/projects/${slug}/from-template` }],
    }
  }
  return null
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const pathname = usePathname()
  const router = useRouter()
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
              action.dropdownItems ? (
                <div className="flex">
                  <Button variant="outline" size="sm" asChild
                    className="text-muted-foreground hover:text-foreground gap-1.5 rounded-r-none border-r-0">
                    <Link href={action.href}>
                      <Plus size={14} />
                      {action.label}
                    </Link>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm"
                        className="rounded-l-none px-2 text-muted-foreground hover:text-foreground">
                        <ChevronDown size={14} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {action.dropdownItems.map((item) => (
                        <DropdownMenuItem key={item.href} onClick={() => router.push(item.href)}>
                          {item.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : (
                <Button variant="outline" size="sm" asChild
                  className="text-muted-foreground hover:text-foreground gap-1.5">
                  <Link href={action.href}>
                    <Plus size={14} />
                    {action.label}
                  </Link>
                </Button>
              )
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
