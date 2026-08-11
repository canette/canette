"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { SkeletonText } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/ui/status-badge"
import type { App, Project } from "@canette/types"

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

  if (error) return <p className="text-destructive text-sm">{error}</p>

  return (
    <div>
      {project?.description && (
        <p className="text-sm text-muted-foreground mb-6">{project.description}</p>
      )}


      {loading ? (
        <SkeletonText />
      ) : apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center rounded-lg border border-dashed border-border">
          <p className="text-sm text-muted-foreground max-w-sm">
            An app is a deployable service — built from a Git repository or Docker image and served at its own URL.
          </p>
          <p className="text-xs text-muted-foreground">
            <Link
              href={`/dashboard/projects/${slug}/apps/new`}
              className="underline underline-offset-2 hover:no-underline"
            >
              Create one manually
            </Link>
            {" "}or{" "}
            <Link
              href={`/dashboard/projects/${slug}/from-template`}
              className="underline underline-offset-2 hover:no-underline"
            >
              load a template
            </Link>
            {" "}to set up a full stack at once.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {apps.map((app) => (
            <Link key={app.id} href={`/dashboard/projects/${slug}/apps/${app.slug}`} className="block group">
              <div className="h-full rounded-lg border border-border bg-card p-[15px] transition-colors group-hover:border-border-strong">
                <div className="flex items-center gap-3">
                  <div className="size-[34px] rounded-md bg-muted flex items-center justify-center font-mono text-xs font-medium text-muted-foreground shrink-0">
                    {app.slug.slice(0, 2)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold font-mono tracking-tight truncate">{app.name}</div>
                    <div className="text-[11.5px] text-tertiary truncate">
                      {app.sourceType === "image"
                        ? `image · ${app.imageTag || "latest"}`
                        : `git · ${app.gitBranch}`}
                      {app.deploymentType !== "web" && ` · ${app.deploymentType}`}
                    </div>
                  </div>
                  <StatusBadge status={app.latestDeploymentStatus} className="shrink-0" />
                </div>
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-tertiary font-mono truncate">
                  <span className="shrink-0">{app.sourceType === "image" ? "⛁" : "↗"}</span>
                  <span className="truncate">{app.sourceType === "image" ? app.imageUrl : app.gitUrl}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
