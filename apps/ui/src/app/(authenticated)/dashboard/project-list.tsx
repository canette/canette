"use client"

import { useEffect, useState } from "react"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import type { Project } from "@canette/types"

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/v1/projects", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => setProjects(data.items ?? []))
      .catch(() => setError("Failed to load projects"))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error) return <p className="text-destructive text-sm">{error}</p>
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground text-sm max-w-lg">
          A project is a workspace for one or more related apps. Each app in a project can be
          deployed independently from a Git repository or a Docker image.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <a href="/dashboard/projects/new" className="block group">
            <div className="h-full rounded-lg border-2 border-dashed border-border group-hover:border-foreground/30 transition-colors flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground group-hover:text-foreground">
              <span className="text-3xl font-light leading-none">+</span>
              <span className="text-sm font-medium">Create project</span>
            </div>
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <a key={p.id} href={`/dashboard/projects/${p.slug}`} className="block group">
          <Card className="h-full transition-colors group-hover:border-foreground/20">
            <CardHeader>
              <CardTitle className="text-base">{p.name}</CardTitle>
              {p.description && (
                <CardDescription>{p.description}</CardDescription>
              )}
              <p className="text-xs text-muted-foreground font-mono pt-1">{p.slug}</p>
            </CardHeader>
          </Card>
        </a>
      ))}
    </div>
  )
}
