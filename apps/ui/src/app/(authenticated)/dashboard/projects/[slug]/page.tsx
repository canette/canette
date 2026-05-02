"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import type { App, Project } from "@canette/types"

type StatusVariant = "live" | "building" | "deploying" | "failed" | "pending" | "secondary"
function statusVariant(status: string | undefined): StatusVariant {
  if (status === "live") return "live"
  if (status === "building" || status === "scanning") return "building"
  if (status === "pending_deployment" || status === "deploying") return "deploying"
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

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error || !project) return <p className="text-destructive text-sm">{error || "Project not found"}</p>

  return (
    <div>
      {project.description && (
        <p className="text-sm text-muted-foreground mb-6">{project.description}</p>
      )}

      {apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center rounded-lg border border-dashed border-border">
          <p className="text-sm text-muted-foreground max-w-sm">
            An app is a deployable service — built from a Git repository or Docker image and served at its own URL.
          </p>
          <Link
            href={`/dashboard/projects/${slug}/apps/new`}
            className="text-sm font-medium underline underline-offset-2 hover:no-underline"
          >
            Add the first app
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <Link key={app.id} href={`/dashboard/projects/${slug}/apps/${app.slug}`} className="block group">
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
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
