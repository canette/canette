"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  ChevronDown,
  Settings,
  Plus,
  Box,
  Hotel,
  Key,
  Users,
  LayoutDashboard,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
} from "lucide-react"
import { CanetteLogo } from "@/components/canette-logo"
import { cn } from "@/lib/utils"
import * as api from "@/lib/api"
import { useSelectedTeam } from "@/lib/team-context"
import type { App, Project, Team } from "@canette/types"

// ── route parsing ─────────────────────────────────────────────────────────────

function parseRoute(pathname: string) {
  const isAdmin = pathname.startsWith("/admin")
  const appMatch = pathname.match(/\/dashboard\/projects\/([^/]+)\/apps\/([^/]+)/)
  const projectMatch = !appMatch ? pathname.match(/\/dashboard\/projects\/([^/]+)/) : null
  const projectSlug = appMatch?.[1] ?? projectMatch?.[1] ?? null
  return {
    isAdmin,
    // "new" is the create-project route, not a real slug
    projectSlug: projectSlug === "new" ? null : projectSlug,
    appSlug: appMatch?.[2] === "new" ? null : (appMatch?.[2] ?? null),
  }
}

// ── nav item ──────────────────────────────────────────────────────────────────

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  indent,
}: {
  href: string
  label: string
  icon?: React.ComponentType<{ size?: number; className?: string }>
  active?: boolean
  collapsed?: boolean
  indent?: boolean
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors min-w-0",
        collapsed && "justify-center",
        indent && !collapsed && "pl-5",
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      )}
    >
      {Icon && <Icon size={15} className="shrink-0" />}
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  )
}

function Divider() {
  return <div className="border-t border-border my-1.5" />
}

// ── team selector (nav area) ──────────────────────────────────────────────────

function TeamSelector({
  teams,
  activeTeam,
  onSelect,
  collapsed,
}: {
  teams: Team[]
  activeTeam: Team | undefined
  onSelect: (id: string) => void
  collapsed: boolean
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const isTeamsPage = pathname.startsWith("/dashboard/teams")
  const hasMultiple = teams.length > 1
  const name = activeTeam ? (activeTeam.isPersonal ? "Personal" : activeTeam.name) : "…"

  if (collapsed) {
    return (
      <Link
        href="/dashboard/teams"
        title="Teams"
        className={cn(
          "flex items-center justify-center px-3 py-1.5 rounded-md transition-colors",
          isTeamsPage
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        )}
      >
        <Hotel size={15} />
      </Link>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => hasMultiple && setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-semibold text-foreground transition-colors",
          isTeamsPage && "bg-muted",
          hasMultiple ? "hover:bg-muted/50 cursor-pointer" : "cursor-default"
        )}
      >
        <Hotel size={15} className="shrink-0" />
        <span className="flex-1 text-left truncate">{name}</span>
        {hasMultiple && (
          <ChevronDown size={13} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        )}
      </button>

      {open && hasMultiple && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-popover border border-border rounded-md shadow-md py-1">
            {teams.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => { onSelect(t.id); setOpen(false) }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-sm transition-colors",
                  t.id === activeTeam?.id
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                {t.isPersonal ? "Personal" : t.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── main sidebar ──────────────────────────────────────────────────────────────

const adminNav = [
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/teams", label: "Teams", icon: Layers },
  { href: "/admin/projects", label: "Projects", icon: LayoutDashboard },
  { href: "/admin/settings", label: "Settings", icon: Settings },
]

const adminBottomNav = [
  { href: "/admin/reconciliation", label: "Reconciliation", icon: ShieldCheck },
]

export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { isAdmin, projectSlug, appSlug } = parseRoute(pathname)

  const { selectedTeamId, setSelectedTeamId } = useSelectedTeam()
  const [teams, setTeams] = useState<Team[]>([])
  const [teamProjects, setTeamProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [apps, setApps] = useState<App[]>([])

  useEffect(() => {
    if (isAdmin) return
    api.teams.list().then(setTeams).catch(() => {})
  }, [isAdmin])

  useEffect(() => {
    if (isAdmin || !projectSlug) {
      setProject(null)
      setApps([])
      return
    }
    let cancelled = false
    api.projects.get(projectSlug)
      .then((p) => {
        if (cancelled) return
        setProject(p)
        return api.apps.list(p.id)
      })
      .then((r) => { if (!cancelled && r) setApps(r.items) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isAdmin, projectSlug])

  // Seed or correct the selected team once the team list is loaded.
  // If the stored selectedTeamId no longer belongs to this user (stale localStorage
  // from another account or session), reset it to the first available team.
  useEffect(() => {
    if (isAdmin || !teams.length) return
    if (!selectedTeamId || !teams.some((t) => t.id === selectedTeamId)) {
      setSelectedTeamId(teams[0].id)
    }
  }, [isAdmin, selectedTeamId, teams, setSelectedTeamId])

  // Fetch projects for the selected team when at team root.
  // Re-fetch the project list on every pathname change when at team root.
  // Using pathname (not projectSlug) as a dep ensures a refresh happens any time
  // the user lands on a non-project page — even via browser back — while keeping
  // the existing list visible during project-page navigation to avoid flashing.
  useEffect(() => {
    if (isAdmin || !selectedTeamId) {
      setTeamProjects([])
      return
    }
    if (projectSlug) return
    let cancelled = false
    fetch("/api/v1/projects", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          const all: Project[] = d.items ?? []
          setTeamProjects(all.filter((p) => p.teamId === selectedTeamId))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [pathname, isAdmin, selectedTeamId, projectSlug])

  const activeTeam = teams.find((t) => t.id === selectedTeamId) ?? teams[0]

  const handleSelectTeam = useCallback((id: string) => {
    setSelectedTeamId(id)
    router.push("/dashboard")
  }, [setSelectedTeamId, router])

  // ── header area (h-14, always rendered) ──────────────────────────────────

  const header = (
    <div className={cn("flex items-center gap-2", collapsed && "justify-center")}>
      <Link href="/dashboard" className="shrink-0 hover:opacity-80 transition-opacity">
        <CanetteLogo className="size-5" />
      </Link>
      {isAdmin && !collapsed && <span className="text-sm font-semibold">Admin</span>}
    </div>
  )

  // ── nav items ─────────────────────────────────────────────────────────────

  let nav: React.ReactNode

  if (isAdmin) {
    nav = (
      <>
        {adminNav.map((item) => (
          <NavItem key={item.href} href={item.href} label={item.label} icon={item.icon}
            active={pathname.startsWith(item.href)} collapsed={collapsed} />
        ))}
        <Divider />
        {adminBottomNav.map((item) => (
          <NavItem key={item.href} href={item.href} label={item.label} icon={item.icon}
            active={pathname.startsWith(item.href)} collapsed={collapsed} />
        ))}
      </>
    )
  } else if (appSlug || projectSlug) {
    // Render the project nav shell immediately from the URL so there is no flash
    // to team-root while project data is loading. Project name, apps list, and
    // team links fill in progressively once the fetch completes.
    const teamId = project?.teamId

    nav = (
      <>
        <Link href="/dashboard" title={collapsed ? "All projects" : undefined}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
          <LayoutDashboard size={15} className="shrink-0" />
          {!collapsed && <span className="truncate">Projects</span>}
        </Link>
        {project && !collapsed && (
          <Link href={`/dashboard/projects/${projectSlug}`}
            className="px-3 py-1 text-sm font-medium text-foreground truncate block rounded-md hover:bg-muted/50 transition-colors">
            {project.name}
          </Link>
        )}
        <Divider />
        <NavItem href={`/dashboard/projects/${projectSlug}`} label="Apps" icon={Box} active={true} collapsed={collapsed} />
        {!collapsed && apps.map((a) => (
          <NavItem key={a.id} href={`/dashboard/projects/${projectSlug}/apps/${a.slug}`}
            label={a.name} active={a.slug === appSlug} collapsed={false} indent />
        ))}
        {!collapsed && (
          <Link href={`/dashboard/projects/${projectSlug}/apps/new`}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors pl-5">
            <Plus size={14} className="shrink-0" />
            <span>Add app</span>
          </Link>
        )}
        {teamId && (
          <>
            <Divider />
            {!activeTeam?.isPersonal && <NavItem href={`/dashboard/teams/${teamId}/members`} label="Team Members" icon={Users} collapsed={collapsed} />}            
            <NavItem href={`/dashboard/teams/${teamId}/credentials`} label="Git Credentials" icon={Key} collapsed={collapsed} />            
          </>
        )}
      </>
    )
  } else {
    // Team root
    const teamId = activeTeam?.id
    nav = (
      <>
        <NavItem href="/dashboard" label="Projects" icon={LayoutDashboard}
          active={pathname === "/dashboard" || pathname.startsWith("/dashboard/projects")}
          collapsed={collapsed} />
        {!collapsed && teamProjects.map((p) => (
          <NavItem
            key={p.id}
            href={`/dashboard/projects/${p.slug}`}
            label={p.name}
            active={false}
            collapsed={false}
            indent
          />
        ))}
        {!collapsed && (
          <Link href="/dashboard/projects/new"
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors pl-5">
            <Plus size={14} className="shrink-0" />
            <span>New project</span>
          </Link>
        )}
        {teamId && !(collapsed && pathname.startsWith("/dashboard/teams")) && (
          <>
            <Divider />
            {!activeTeam?.isPersonal && <NavItem href={`/dashboard/teams/${teamId}/members`} label="Team Members" icon={Users} collapsed={collapsed} />}
            <NavItem href={`/dashboard/teams/${teamId}/credentials`} label="Git Credentials" icon={Key} collapsed={collapsed} />            
          </>
        )}
      </>
    )
  }

  // Prepend the team selector to every non-admin nav
  if (!isAdmin) {
    nav = (
      <>
        <TeamSelector teams={teams} activeTeam={activeTeam} onSelect={handleSelectTeam} collapsed={collapsed} />
        <Divider />
        {nav}
      </>
    )
  }

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border bg-background transition-all duration-200 shrink-0",
        collapsed ? "w-[52px]" : "w-[220px]"
      )}
    >
      {/* Header row — same h-14 as top bar, with matching border-b */}
      <div className={cn(
        "h-14 border-b border-border flex items-center shrink-0",
        collapsed ? "px-3 justify-center" : "px-4"
      )}>
        {header}
      </div>

      {/* Nav content */}
      <div className="flex-1 overflow-y-auto py-2 px-2">
        <div className="flex flex-col gap-0.5">
          {nav}
        </div>
      </div>

      {/* Collapse toggle */}
      <div className="px-2 py-2">
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
            collapsed ? "justify-center w-full" : "w-full"
          )}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      </div>
    </aside>
  )
}
