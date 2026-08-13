"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator } from "@/components/ui/select"
import { ChevronDown } from "lucide-react"
import * as api from "@/lib/api"
import type { AdminProjectOverview, AdminTeamOverview } from "@canette/types"
import { SkeletonText } from "@/components/ui/skeleton"
import { HostnameManager } from "@/components/hostname-manager"

type StatusVariant = "live" | "building" | "deploying" | "failed" | "pending" | "secondary"

function statusVariant(status: string | undefined): StatusVariant {
  if (status === "live") return "live"
  if (status === "building") return "building"
  if (status === "deploying") return "deploying"
  if (status === "failed") return "failed"
  if (status === "stopped") return "secondary"
  return "pending"
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      size={16}
      className={`text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    />
  )
}

export default function AdminProjectsPage() {
  const [overview, setOverview] = useState<AdminProjectOverview[]>([])
  const [adminTeams, setAdminTeams] = useState<AdminTeamOverview[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [projectTeamFilter, setProjectTeamFilter] = useState("all")
  const [hostnameApp, setHostnameApp] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    Promise.all([api.admin.getOverview(), api.admin.getTeams()])
      .then(([o, t]) => { setOverview(o); setAdminTeams(t) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  function toggleProject(id: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  if (loading) return <SkeletonText />
  if (error) return <p className="text-destructive text-sm">{error}</p>

  const regularTeams = adminTeams.filter((t) => !t.isPersonal && overview.some((p) => p.teamName === t.name))
  const personalTeams = adminTeams.filter((t) => t.isPersonal && overview.some((p) => p.teamName === t.name))
  const showFilter = regularTeams.length + personalTeams.length > 1

  const filtered = projectTeamFilter === "all"
    ? overview
    : overview.filter((p) => p.teamName === projectTeamFilter)

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">All projects across all teams.</p>
        </div>
        {showFilter && (
          <Select value={projectTeamFilter} onValueChange={setProjectTeamFilter}>
            <SelectTrigger className="w-40 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {regularTeams.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Teams</SelectLabel>
                    {regularTeams.map((t) => <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>)}
                  </SelectGroup>
                </>
              )}
              {personalTeams.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Personal</SelectLabel>
                    {personalTeams.map((t) => <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>)}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="rounded-lg border border-border">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm px-6 py-4">No projects yet.</p>
        ) : (
          filtered.map((project, i) => (
            <div key={project.id}>
              {i > 0 && <Separator />}
              <button
                type="button"
                className="w-full flex items-center justify-between px-6 py-3 hover:bg-muted/40 transition-colors text-left"
                onClick={() => toggleProject(project.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{project.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{project.slug}</span>
                  <span className="text-xs text-muted-foreground">{project.teamName}</span>
                  <span className="text-xs text-muted-foreground">{project.apps.length} app{project.apps.length !== 1 ? "s" : ""}</span>
                </div>
                <Chevron open={expandedProjects.has(project.id)} />
              </button>
              {expandedProjects.has(project.id) && project.apps.length > 0 && (
                <div className="border-t border-border/50 bg-muted/20">
                  {project.apps.map((app, j) => (
                    <div key={app.id}>
                      {j > 0 && <Separator />}
                      <div className="flex items-center justify-between pl-10 pr-6 py-2.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <Link href={`/dashboard/projects/${project.slug}/apps/${app.slug}`} className="text-sm hover:underline truncate">
                            {app.name}
                          </Link>
                          <span className="text-xs text-muted-foreground shrink-0">{app.sourceType}</span>
                          {app.liveUrl && app.latestDeploymentStatus === "live" && (
                            <a
                              href={app.liveUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-mono text-muted-foreground hover:text-foreground hover:underline truncate"
                            >
                              {app.liveUrl}
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                            onClick={() => setHostnameApp({ id: app.id, name: app.name })}>
                            Hostnames
                          </Button>
                          {app.latestDeploymentStatus && (
                            <Badge variant={statusVariant(app.latestDeploymentStatus)}>
                              {app.latestDeploymentStatus}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {expandedProjects.has(project.id) && project.apps.length === 0 && (
                <p className="text-xs text-muted-foreground pl-10 pr-6 py-2.5 border-t border-border/50 bg-muted/20">No apps in this project.</p>
              )}
            </div>
          ))
        )}
      </div>

      <Dialog open={!!hostnameApp} onOpenChange={(open) => { if (!open) setHostnameApp(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Custom domains — {hostnameApp?.name}</DialogTitle>
          </DialogHeader>
          <div className="px-6 pb-6">
            {hostnameApp && <HostnameManager appId={hostnameApp.id} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
