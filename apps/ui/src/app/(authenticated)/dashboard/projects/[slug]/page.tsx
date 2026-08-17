"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react"
import { SkeletonText } from "@/components/ui/skeleton"
import { StatusBadge } from "@/components/ui/status-badge"
import { cn } from "@/lib/utils"
import type { App, Project } from "@canette/types"

export default function ProjectPage() {
  const { slug } = useParams<{ slug: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [apps, setApps] = useState<App[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [moving, setMoving] = useState<Set<string>>(new Set())
  const [reordering, setReordering] = useState(false)

  async function handleMove(appId: string, direction: "up" | "down") {
    setMoving((s) => new Set(s).add(appId))
    try {
      const r = await fetch(`/api/v1/apps/${appId}/move`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      })
      if (!r.ok) throw new Error("Failed to reorder")
      const data = await r.json()
      setApps(data.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reorder")
    } finally {
      setMoving((s) => {
        const n = new Set(s)
        n.delete(appId)
        return n
      })
    }
  }

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
          <p className="text-sm font-medium">Get your first app running</p>
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
        <>
          <div className="grid gap-3 sm:grid-cols-2">
          {apps.map((app, index) => (
            <div key={app.id} className="relative group/card">
              <Link href={`/dashboard/projects/${slug}/apps/${app.slug}`} className="block h-full">
                <div className="h-full rounded-lg border border-border bg-card p-[15px] transition-colors group-hover/card:border-border-strong">
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
              {reordering && apps.length > 1 && (
                <div className="absolute top-1.5 right-1.5 flex flex-col">
                  <button
                    type="button"
                    aria-label={`Move ${app.name} up`}
                    disabled={index === 0 || moving.has(app.id)}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleMove(app.id, "up")
                    }}
                    className={cn(
                      "h-4 w-5 flex items-center justify-center rounded-t-sm border border-border bg-card text-tertiary",
                      "hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                    )}
                  >
                    <ChevronUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${app.name} down`}
                    disabled={index === apps.length - 1 || moving.has(app.id)}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleMove(app.id, "down")
                    }}
                    className={cn(
                      "h-4 w-5 flex items-center justify-center rounded-b-sm border border-t-0 border-border bg-card text-tertiary",
                      "hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:pointer-events-none"
                    )}
                  >
                    <ChevronDown className="size-3" />
                  </button>
                </div>
              )}
            </div>
          ))}
          </div>
          {apps.length > 1 && (
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setReordering((v) => !v)}
                title="Toggle reorder"
                aria-pressed={reordering}
                aria-label={reordering ? "Done reordering" : "Reorder apps"}
                className={cn(
                  "flex items-center justify-center size-7 rounded-md transition-colors shrink-0",
                  reordering
                    ? "text-foreground bg-muted"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <ArrowUpDown size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
