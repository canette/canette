"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import * as api from "@/lib/api"
import type { Project, Team } from "@canette/types"

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/projects", { credentials: "include" }).then((r) => r.json()).then((d) => d.items ?? []),
      api.teams.list(),
    ])
      .then(([p, t]) => { setProjects(p); setTeams(t) })
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
          <Link href="/dashboard/projects/new" className="block group">
            <div className="h-full rounded-lg border-2 border-dashed border-border group-hover:border-foreground/30 transition-colors flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground group-hover:text-foreground">
              <span className="text-3xl font-light leading-none">+</span>
              <span className="text-sm font-medium">Create project</span>
            </div>
          </Link>
        </div>
      </div>
    )
  }

  const teamMap = new Map(teams.map((t) => [t.id, t]))

  // Group projects by team, preserving the order teams appear in the teams list.
  const teamIds = teams.map((t) => t.id)
  const grouped = teamIds
    .map((id) => ({ team: teamMap.get(id)!, projects: projects.filter((p) => p.teamId === id) }))
    .filter((g) => g.projects.length > 0)

  // Projects whose teamId isn't in the teams list (shouldn't happen, but be safe).
  const knownTeamIds = new Set(teamIds)
  const ungrouped = projects.filter((p) => !knownTeamIds.has(p.teamId))
  if (ungrouped.length > 0) grouped.push({ team: null as unknown as Team, projects: ungrouped })

  const showHeaders = grouped.length > 1

  return (
    <div className="flex flex-col gap-8">
      {grouped.map(({ team, projects: groupProjects }) => (
        <div key={team?.id ?? "unknown"}>
          {showHeaders && team && (
            <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-3">
              {team.isPersonal ? "Personal" : team.name}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {groupProjects.map((p) => (
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
        </div>
      ))}
    </div>
  )
}
