"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { SkeletonText } from "@/components/ui/skeleton"
import { StatusBadge, StatusLabel } from "@/components/ui/status-badge"
import * as api from "@/lib/api"
import { useSelectedTeam } from "@/lib/team-context"
import type { App, Project, Team } from "@canette/types"

const PROJECT_COLORS = ["#30a46c", "#6e56cf", "#0090ff", "#f76b15", "#12a594", "#e5484d"]

function projectColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
  return PROJECT_COLORS[Math.abs(h) % PROJECT_COLORS.length]
}

/** Aggregate status chip for a project card: worst state wins. */
function projectAggregate(apps: App[]): { status: string; label: string } | null {
  if (apps.length === 0) return null
  const count = (pred: (s: string | undefined) => boolean) =>
    apps.filter((a) => pred(a.latestDeploymentStatus)).length
  const failed = count((s) => s === "failed")
  if (failed > 0) return { status: "failed", label: `${failed} failed` }
  const building = count((s) => !!s && ["pending_build", "building", "scanning", "pending_deployment", "deploying"].includes(s))
  if (building > 0) return { status: "building", label: `${building} building` }
  const live = count((s) => s === "live")
  if (live > 0) return { status: "live", label: `${live} live` }
  return null
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

  const isZeroState = !loading && !error &&
    (projects.length === 0 || (selectedTeamId && !projects.some((p) => p.teamId === selectedTeamId)))

  const teamMap = new Map(teams.map((t) => [t.id, t]))
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

      {error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : loading ? (
        <SkeletonText />
      ) : isZeroState ? (
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
      ) : (
        <div className="flex flex-col gap-8">
          {grouped.map(({ team, projects: groupProjects }) => (
            <div key={team?.id ?? "unknown"}>
              {showHeaders && team && (
                <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-3">
                  {team.isPersonal ? "Personal" : team.name}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {groupProjects.map((p) => {
                  const projApps = appsByProject[p.id] ?? []
                  const agg = projectAggregate(projApps)
                  return (
                    <Link key={p.id} href={`/dashboard/projects/${p.slug}`} className="block group">
                      <div className="h-full rounded-lg border border-border bg-card p-[18px] transition-colors group-hover:border-border-strong">
                        <div className="flex items-center gap-2.5 mb-1">
                          <span
                            className="size-2.5 rounded-[3px] shrink-0"
                            style={{ background: projectColor(p.id) }}
                          />
                          <span className="font-semibold text-[15px] tracking-tight flex-1 truncate">{p.name}</span>
                          {agg && <StatusBadge status={agg.status} label={agg.label} className="shrink-0" />}
                        </div>
                        {p.description ? (
                          <p className="text-[12.5px] text-muted-foreground leading-relaxed mb-3 line-clamp-2">{p.description}</p>
                        ) : (
                          <p className="text-[12.5px] text-tertiary font-mono mb-3">{p.slug}</p>
                        )}
                        {projApps.length > 0 && (
                          <div className="flex flex-col gap-px rounded-md overflow-hidden ring-1 ring-border ring-inset mb-3">
                            {projApps.map((a) => (
                              <div key={a.id} className="flex items-center gap-2.5 px-3 py-2 bg-panel-soft">
                                <span className="size-[22px] rounded-sm bg-card ring-1 ring-border ring-inset flex items-center justify-center font-mono text-[10px] font-medium text-muted-foreground shrink-0">
                                  {a.slug.slice(0, 2)}
                                </span>
                                <span className="text-[12.5px] font-medium font-mono truncate">{a.name}</span>
                                <StatusLabel status={a.latestDeploymentStatus} className="ml-auto text-[11.5px] shrink-0" />
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center text-xs text-tertiary">
                          <span>{projApps.length === 1 ? "1 app" : `${projApps.length} apps`}</span>
                          <span className="ml-auto font-mono">{p.slug}</span>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
