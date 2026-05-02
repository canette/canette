"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { AppProvider } from "@/lib/app-context"
import { cn } from "@/lib/utils"
import * as api from "@/lib/api"
import type { App, Project } from "@canette/types"

function AppTabs({ appBase }: { appBase: string }) {
  const pathname = usePathname()
  const isOverview = pathname === appBase || pathname === `${appBase}/`
  const isDeployments = pathname.startsWith(`${appBase}/deployments`)
  const isSettings = pathname.startsWith(`${appBase}/settings`)

  const tabs = [
    { label: "Overview", href: appBase, active: isOverview },
    { label: "Deployments", href: `${appBase}/deployments`, active: isDeployments },
    { label: "Settings", href: `${appBase}/settings`, active: isSettings },
  ]

  return (
    <nav className="flex border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            "px-3 py-2 text-sm border-b-2 -mb-px transition-colors",
            tab.active
              ? "border-foreground text-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const [app, setApp] = useState<App | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        fetch(`/api/v1/projects/${slug}`, { credentials: "include" }).then((r) => {
          if (!r.ok) throw new Error("Project not found")
          return r.json() as Promise<Project>
        }),
        api.apps.getBySlug(slug, appSlug),
      ])
      setProject(p)
      setApp(a)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load")
    }
  }, [slug, appSlug])

  useEffect(() => { load() }, [load])

  if (error) return <p className="text-destructive text-sm">{error}</p>
  if (!app || !project) return <p className="text-muted-foreground text-sm">Loading…</p>

  const appBase = `/dashboard/projects/${slug}/apps/${appSlug}`

  return (
    <AppProvider value={{ app, project, refresh: load }}>
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold mb-4">{app.name}</h1>
          <AppTabs appBase={appBase} />
        </div>
        {children}
      </div>
    </AppProvider>
  )
}
