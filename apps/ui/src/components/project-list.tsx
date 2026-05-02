"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import * as api from "@/lib/api"
import { useSelectedTeam } from "@/lib/team-context"
import type { App, Project, Team } from "@canette/types"

type StatusVariant = "live" | "building" | "deploying" | "failed" | "pending" | "secondary"
function statusVariant(status: string | undefined): StatusVariant {
  if (status === "live") return "live"
  if (status === "building") return "building"
  if (status === "scanning") return "building"
  if (status === "pending_deployment" || status === "deploying") return "deploying"
  if (status === "failed") return "failed"
  if (status === "stopped") return "secondary"
  return "pending"
}

export function ProjectList() {
  const { selectedTeamId } = useSelectedTeam()
  const [projects, setProjects] = useState<Project[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [appsByProject, setAppsByProject] = useState<Record<string, App[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/projects", { credentials: "include" }).then((r) => r.json()).then((d) => d.items ?? []),
      api.teams.list(),
    ])
      .then(([p, t]: [Project[], Team[]]) => {
        setProjects(p)
        setTeams(t)
        // Fetch apps for each project for status dots
        return Promise.all(
          p.map((proj) =>
            api.apps.list(proj.id)
              .then((r) => [proj.id, r.items] as [string, App[]])
              .catch(() => [proj.id, []] as [string, App[]])
          )
        )
      })
      .then((entries) => setAppsByProject(Object.fromEntries(entries)))
      .catch(() => setError("Failed to load projects"))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error) return <p className="text-destructive text-sm">{error}</p>

  if (projects.length === 0 || (selectedTeamId && !projects.some((p) => p.teamId === selectedTeamId))) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground text-sm">
          A project is a workspace for one or more related apps. Each app can be deployed independently
          from a Git repository or a Docker image.
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

  // Filter to selected team, falling back to all if nothing is selected
  const visibleProjects = selectedTeamId
    ? projects.filter((p) => p.teamId === selectedTeamId)
    : projects

  const teamIds = teams.map((t) => t.id)
  const grouped = teamIds
    .map((id) => ({ team: teamMap.get(id)!, projects: visibleProjects.filter((p) => p.teamId === id) }))
    .filter((g) => g.projects.length > 0)

  const knownTeamIds = new Set(teamIds)
  const ungrouped = visibleProjects.filter((p) => !knownTeamIds.has(p.teamId))
  if (ungrouped.length > 0) grouped.push({ team: null as unknown as Team, projects: ungrouped })

  const showHeaders = grouped.length > 1

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Projects</h1>
      <div className="flex flex-col gap-8">
        {grouped.map(({ team, projects: groupProjects }) => (
          <div key={team?.id ?? "unknown"}>
            {showHeaders && team && (
              <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-3">
                {team.isPersonal ? "Personal" : team.name}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {groupProjects.map((p) => {
                const projApps = appsByProject[p.id] ?? []
                return (
                  <a key={p.id} href={`/dashboard/projects/${p.slug}`} className="block group">
                    <Card className="h-full transition-colors group-hover:border-foreground/20">
                      <CardHeader>
                        <CardTitle className="text-base">{p.name}</CardTitle>
                        {p.description && (
                          <CardDescription>{p.description}</CardDescription>
                        )}
                        <p className="text-xs text-muted-foreground font-mono pt-1">{p.slug}</p>
                        {projApps.length > 0 && (
                          <div className="flex flex-col gap-1 pt-2">
                            {projApps.map((a) => (
                              <div key={a.id} className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground truncate flex-1">{a.name}</span>
                                {a.latestDeploymentStatus && (
                                  <Badge variant={statusVariant(a.latestDeploymentStatus)} className="text-[10px] py-0 h-4 shrink-0">
                                    {a.latestDeploymentStatus}
                                  </Badge>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </CardHeader>
                    </Card>
                  </a>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
