"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Settings, ArrowLeft } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import type { Project, App } from "@canette/types"

type StatusVariant = "live" | "building" | "deploying" | "failed" | "pending" | "secondary"
function statusVariant(status: string | undefined): StatusVariant {
  if (status === "live") return "live"
  if (status === "building") return "building"
  if (status === "deploying") return "deploying"
  if (status === "failed") return "failed"
  if (status === "stopped") return "secondary"
  return "pending"
}

export default function ProjectPage() {
  const { slug } = useParams<{ slug: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [apps, setApps] = useState<App[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch(`/api/v1/projects/${slug}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Project not found")
        return r.json()
      })
      .then((p: Project) => {
        setProject(p)
        return fetch(`/api/v1/projects/${p.id}/apps`, { credentials: "include" })
      })
      .then((r) => r.json())
      .then((data) => setApps(data.items ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [slug])

  if (loading) {
    return <Shell slug={slug}><p className="text-muted-foreground text-sm">Loading…</p></Shell>
  }
  if (error || !project) {
    return <Shell slug={slug}><p className="text-destructive text-sm">{error || "Project not found"}</p></Shell>
  }

  return (
    <Shell project={project}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Apps</CardTitle>
        </CardHeader>
        <CardContent>
          {apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
              <p className="text-muted-foreground text-sm">No apps yet.</p>
              <Button asChild size="sm">
                <a href={`/dashboard/projects/${slug}/apps/new`}>Add app</a>
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {apps.map((app) => (
                <a key={app.id} href={`/dashboard/projects/${slug}/apps/${app.slug}`} className="block group">
                  <Card className="h-full transition-colors group-hover:border-foreground/20">
                    <CardHeader>
                      <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-base truncate">{app.name}</CardTitle>
                        {app.latestDeploymentStatus && (
                          <Badge variant={statusVariant(app.latestDeploymentStatus)} className="shrink-0">
                            {app.latestDeploymentStatus}
                          </Badge>
                        )}
                      </div>
                      {app.sourceType === "image" ? (
                        <>
                          <CardDescription className="font-mono text-xs truncate">{app.imageUrl}</CardDescription>
                          <p className="text-xs text-muted-foreground">{app.imageTag || "latest"}</p>
                        </>
                      ) : (
                        <>
                          <CardDescription className="font-mono text-xs truncate">{app.gitUrl}</CardDescription>
                          <p className="text-xs text-muted-foreground">{app.gitBranch}</p>
                        </>
                      )}
                    </CardHeader>
                  </Card>
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Shell>
  )
}

function Shell({ project, slug, children }: {
  project?: Project | null
  slug?: string
  children: React.ReactNode
}) {
  const name = project?.name ?? slug ?? "…"
  const projectSlug = project?.slug ?? slug ?? ""

  return (
    <AppShell
      breadcrumb={[{ label: name }]}
      actions={project ? (
        <Button asChild size="sm">
          <a href={`/dashboard/projects/${projectSlug}/apps/new`}>Add app</a>
        </Button>
      ) : undefined}
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-start gap-3">
          <a href="/dashboard" className="text-muted-foreground hover:text-foreground transition-colors mt-1">
            <ArrowLeft size={18} />
          </a>
          <div>
            <h1 className="text-xl font-semibold">{name}</h1>
            {project?.description && (
              <p className="text-sm text-muted-foreground mt-1">{project.description}</p>
            )}
          </div>
        </div>
        {project && (
          <a
            href={`/dashboard/projects/${projectSlug}/settings`}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Project settings"
          >
            <Settings size={18} />
          </a>
        )}
      </div>
      {children}
    </AppShell>
  )
}
