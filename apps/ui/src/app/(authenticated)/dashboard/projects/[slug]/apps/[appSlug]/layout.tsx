"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, usePathname } from "next/navigation"
import { AppProvider } from "@/lib/app-context"
import { TabNavigation } from "@/components/tab-navigation"
import { StatusBadge } from "@/components/ui/status-badge"
import { HostnameAltMenu } from "@/components/hostname-alt-menu"
import { ExternalLink } from "lucide-react"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import { useDomain } from "@/lib/domain-context"
import { computeAppUrl } from "@/lib/deployment-format"
import * as api from "@/lib/api"
import type { App, AppHostname, Project } from "@canette/types"

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const pathname = usePathname()
  const domain = useDomain()
  const [app, setApp] = useState<App | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [hostnames, setHostnames] = useState<AppHostname[]>([])
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
      // Best-effort: hostnames are supplementary, don't block the rest of the page on it.
      api.hostnames.list(a.id).then((h) => setHostnames(h.items)).catch(() => setHostnames([]))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load")
    }
  }, [slug, appSlug])

  useEffect(() => { load() }, [load])

  const computedUrl = app && project && domain && app.deploymentType === "web"
    ? computeAppUrl(app.slug, project.slug, domain)
    : null
  const isLive = app?.latestDeploymentStatus === "live"

  const appBase = `/dashboard/projects/${slug}/apps/${appSlug}`
  const isOverview = pathname === appBase || pathname === `${appBase}/`
  const isDeployments = pathname.startsWith(`${appBase}/deployments`)
  const isLogs = pathname.startsWith(`${appBase}/logs`)
  const isSettings = pathname.startsWith(`${appBase}/settings`)

  return (
    <div className="flex flex-col gap-6">
      <div>
        {app ? (
          <div className="flex items-center gap-3.5 mb-4">
            <div className="size-10 rounded-lg bg-muted flex items-center justify-center font-mono text-sm font-medium text-muted-foreground shrink-0">
              {app.slug.slice(0, 2)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-semibold font-mono tracking-tight truncate">{app.name}</h1>
                <StatusBadge status={app.latestDeploymentStatus} className="shrink-0" />
              </div>
              {computedUrl && (
                <div className="flex items-center gap-1.5">
                  {isLive ? (
                    <a
                      href={computedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-1.5 w-fit rounded-md border border-border px-2 py-0.5 text-[13px] font-mono hover:border-foreground/30 transition-colors"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                      {computedUrl.replace(/^https?:\/\//, "")}
                      <ExternalLink size={11} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                    </a>
                  ) : (
                    <span className="flex items-center gap-1.5 w-fit rounded-md border border-dashed border-border px-2 py-0.5 text-[13px] font-mono text-muted-foreground">
                      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                      {computedUrl.replace(/^https?:\/\//, "")}
                    </span>
                  )}
                  {isLive && <HostnameAltMenu primaryUrl={computedUrl} hostnames={hostnames} />}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3.5 mb-4">
            <Skeleton className="size-10 rounded-lg" />
            <Skeleton className="h-7 w-40" />
          </div>
        )}
        <TabNavigation tabs={[
          { label: "Overview", href: appBase, active: isOverview },
          { label: "Deployments", href: `${appBase}/deployments`, active: isDeployments },
          { label: "Logs", href: `${appBase}/logs`, active: isLogs },
          { label: "Settings", href: `${appBase}/settings`, active: isSettings },
        ]} />
      </div>
      {error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : !app || !project ? (
        <SkeletonText />
      ) : (
        <AppProvider value={{ app, project, refresh: load, hostnames }}>
          {children}
        </AppProvider>
      )}
    </div>
  )
}
