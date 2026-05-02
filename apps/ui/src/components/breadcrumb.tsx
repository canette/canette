"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSelectedTeam } from "@/lib/team-context"
import * as api from "@/lib/api"

interface Crumb {
  label: string
  href?: string
}

function useBreadcrumbs(): Crumb[] {
  const pathname = usePathname()
  const { selectedTeamId } = useSelectedTeam()

  const [teamName, setTeamName] = useState<string | null>(null)
  const [projectName, setProjectName] = useState<string | null>(null)
  const [appName, setAppName] = useState<string | null>(null)

  const isAdmin = pathname.startsWith("/admin")
  const isSettings = pathname.startsWith("/account")
  const segments = pathname.split("/").filter(Boolean)
  // segments: ["dashboard", "projects", slug, "apps", appSlug, ...]
  // or:       ["settings", "profile"]

  const projectSlug =
    !isAdmin && !isSettings && segments[0] === "dashboard" && segments[1] === "projects" && segments[2] && segments[2] !== "new"
      ? segments[2]
      : null
  const appSlug =
    projectSlug && segments[3] === "apps" && segments[4] && segments[4] !== "new"
      ? segments[4]
      : null
  const isNewProject = !isAdmin && !isSettings && segments[0] === "dashboard" && segments[1] === "projects" && segments[2] === "new"
  const isNewApp = !!projectSlug && segments[3] === "apps" && segments[4] === "new"
  const isTeamsPage = !isAdmin && !isSettings && segments[0] === "dashboard" && segments[1] === "teams"
  const teamsSection = isTeamsPage ? segments[3] : null // "members" | "credentials"

  // Team name — show the real name, not "Personal"
  useEffect(() => {
    if (isAdmin || !selectedTeamId) return
    api.teams.list()
      .then((ts) => {
        const t = ts.find((t) => t.id === selectedTeamId)
        setTeamName(t?.name ?? null)
      })
      .catch(() => {})
  }, [isAdmin, selectedTeamId])

  // Project name
  useEffect(() => {
    if (!projectSlug) { setProjectName(null); return }
    api.projects.get(projectSlug)
      .then((p) => setProjectName(p.name))
      .catch(() => setProjectName(projectSlug))
  }, [projectSlug])

  // App name
  useEffect(() => {
    if (!projectSlug || !appSlug) { setAppName(null); return }
    api.apps.getBySlug(projectSlug, appSlug)
      .then((a) => setAppName(a?.name ?? appSlug))
      .catch(() => setAppName(appSlug))
  }, [projectSlug, appSlug])

  // ── Settings breadcrumbs ─────────────────────────────────────────────────
  if (isSettings) {
    const sectionLabels: Record<string, string> = {
      profile: "Profile",
    }
    const section = segments[1] ? sectionLabels[segments[1]] : null
    return section ? [{ label: "Account" }, { label: section }] : [{ label: "Account" }]
  }

  // ── Admin breadcrumbs ─────────────────────────────────────────────────────
  if (isAdmin) {
    const sectionLabels: Record<string, string> = {
      users: "Users",
      teams: "Teams",
      projects: "Projects",
      settings: "Settings",
      reconciliation: "Reconciliation",
    }
    const section = segments[1] ? sectionLabels[segments[1]] : null
    return [
      { label: "Admin" },
      ...(section ? [{ label: section }] : []),
    ]
  }

  // ── Regular breadcrumbs ───────────────────────────────────────────────────
  const hasChildren = !!(projectSlug || isNewProject || isTeamsPage)
  const crumbs: Crumb[] = [
    { label: teamName ?? "…", href: hasChildren ? "/dashboard" : undefined },
  ]

  if (isNewProject) {
    crumbs.push({ label: "New project" })
  } else if (projectSlug) {
    const hasAppChildren = !!(appSlug || isNewApp)
    crumbs.push({
      label: projectName ?? projectSlug,
      href: hasAppChildren ? `/dashboard/projects/${projectSlug}` : undefined,
    })
    if (isNewApp) {
      crumbs.push({ label: "New app" })
    } else if (appSlug) {
      crumbs.push({ label: appName ?? appSlug })
    }
  } else if (isTeamsPage) {
    if (teamsSection === "members") crumbs.push({ label: "Members" })
    else if (teamsSection === "credentials") crumbs.push({ label: "Credentials" })
  }

  return crumbs
}

export function Breadcrumb() {
  const crumbs = useBreadcrumbs()
  if (crumbs.length === 0) return null

  return (
    <nav className="flex items-center gap-1 text-sm min-w-0">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <span key={i} className="flex items-center gap-1 min-w-0">
            {i > 0 && (
              <span className="text-muted-foreground/40 shrink-0 select-none">›</span>
            )}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="text-muted-foreground hover:text-foreground transition-colors truncate"
              >
                {crumb.label}
              </Link>
            ) : (
              <span className={isLast ? "text-foreground font-medium truncate" : "text-muted-foreground truncate"}>
                {crumb.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}
