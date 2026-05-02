"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, usePathname } from "next/navigation"
import { AppProvider } from "@/lib/app-context"
import { TabNavigation } from "@/components/tab-navigation"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import * as api from "@/lib/api"
import type { App, Project } from "@canette/types"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const pathname = usePathname()
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

  const appBase = `/dashboard/projects/${slug}/apps/${appSlug}`
  const isOverview = pathname === appBase || pathname === `${appBase}/`
  const isDeployments = pathname.startsWith(`${appBase}/deployments`)
  const isSettings = pathname.startsWith(`${appBase}/settings`)

  return (
    <div className="flex flex-col gap-6">
      <div>
        {app
          ? <h1 className="text-xl font-semibold mb-4">{app.name}</h1>
          : <Skeleton className="h-7 w-40 mb-4" />
        }
        <TabNavigation tabs={[
          { label: "Overview", href: appBase, active: isOverview },
          { label: "Deployments", href: `${appBase}/deployments`, active: isDeployments },
          { label: "Settings", href: `${appBase}/settings`, active: isSettings },
        ]} />
      </div>
      {error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : !app || !project ? (
        <SkeletonText />
      ) : (
        <AppProvider value={{ app, project, refresh: load }}>
          {children}
        </AppProvider>
      )}
    </div>
  )
}
