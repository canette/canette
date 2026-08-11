"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import {
  ChevronDown,
  Settings,
  Plus,
  Box,
  Key,
  Users,
  LayoutDashboard,
  Layers,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  Sun,
} from "lucide-react"
import { CanetteLogo } from "@/components/canette-logo"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
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
          ? "bg-accent-soft font-medium text-accent-text"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
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

// ── team initial square ───────────────────────────────────────────────────────

const TEAM_COLORS = ["#30a46c", "#6e56cf", "#0090ff", "#e5484d", "#f76b15", "#12a594"]

function teamColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
  return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length]
}

function TeamInitial({ team, size = 22 }: { team: Team; size?: number }) {
  const label = team.isPersonal ? "Personal" : team.name
  return (
    <span
      className="flex items-center justify-center rounded-sm text-white font-semibold shrink-0"
      style={{ width: size, height: size, background: teamColor(team.id), fontSize: size * 0.5 }}
    >
      {label.trim().charAt(0).toUpperCase()}
    </span>
  )
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
  const pathname = usePathname()
  const isTeamsPage = pathname.startsWith("/dashboard/teams")
  const hasMultiple = teams.length > 1
  const name = activeTeam ? (activeTeam.isPersonal ? "Personal" : activeTeam.name) : "…"

  if (collapsed) {
    return (
      <Link
        href="/dashboard/teams"
        title={activeTeam ? `Teams — ${name}` : "Teams"}
        className={cn(
          "flex items-center justify-center px-3 py-1.5 rounded-md transition-colors",
          isTeamsPage
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
        )}
      >
        {activeTeam ? <TeamInitial team={activeTeam} size={20} /> : <Layers size={15} className="shrink-0" />}
      </Link>
    )
  }

  return (
    <div className={cn(
      "flex items-center rounded-md border border-input bg-card transition-colors",
      isTeamsPage && "bg-muted",
    )}>
      <Link
        href="/dashboard/teams"
        className={cn(
          "flex-1 flex items-center gap-2.5 pl-2 pr-1 py-1.5 text-sm transition-colors hover:bg-muted min-w-0",
          hasMultiple ? "rounded-l-md" : "rounded-md",
        )}
      >
        {activeTeam ? <TeamInitial team={activeTeam} /> : <Layers size={15} className="shrink-0" />}
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-medium truncate leading-tight">{name}</span>
          <span className="block text-[11px] text-tertiary leading-tight">
            {activeTeam?.isPersonal ? "Your workspace" : "Team"}
          </span>
        </span>
      </Link>
      {hasMultiple && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Switch team"
              className="group self-stretch px-1.5 rounded-r-md transition-colors text-tertiary hover:text-foreground hover:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground"
            >
              <ChevronDown size={13} className="transition-transform group-data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-[13rem]">
            {teams.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onSelect={() => onSelect(t.id)}
                className={cn(
                  "flex items-center gap-2.5",
                  t.id === activeTeam?.id ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                <TeamInitial team={t} size={20} />
                <span className="flex-1 truncate">{t.isPersonal ? "Personal" : t.name}</span>
                {t.id === activeTeam?.id && <span className="text-accent-text text-xs">✓</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

// ── fleet health ──────────────────────────────────────────────────────────────

const BUILDING_STATUSES = new Set(["pending_build", "building", "scanning", "pending_deployment", "deploying"])

function FleetHealth({ apps }: { apps: App[] }) {
  // Apps that are stopped, or have never been deployed, aren't part of the
  // live fleet — excluding them keeps the percentage and the live/building/failed
  // breakdown below it consistent with each other (they always sum to total).
  const live = apps.filter((a) => a.latestDeploymentStatus === "live").length
  const building = apps.filter((a) => BUILDING_STATUSES.has(a.latestDeploymentStatus ?? "")).length
  const failed = apps.filter((a) => a.latestDeploymentStatus === "failed").length
  const total = live + building + failed
  if (total === 0) return null
  const pct = Math.round((live / total) * 100)

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5 mb-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">Fleet health</span>
        <span className={cn("text-xs font-semibold", failed > 0 ? "text-warning-text" : "text-success-text")}>
          {pct}%
        </span>
      </div>
      <div className="h-[5px] rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-success rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex gap-2.5 mt-2 text-[11px] text-tertiary">
        <span><b className="font-semibold text-success-text">{live}</b> live</span>
        <span><b className="font-semibold text-warning-text">{building}</b> building</span>
        <span><b className="font-semibold text-destructive-text">{failed}</b> failed</span>
      </div>
    </div>
  )
}

// ── theme toggle ──────────────────────────────────────────────────────────────

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <button
      type="button"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      title="Toggle appearance"
      className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
    >
      {mounted && resolvedTheme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
    </button>
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
  const [teamApps, setTeamApps] = useState<App[]>([])

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

  // Fetch team projects when inside a project (for the quick-switch dropdown).
  useEffect(() => {
    if (isAdmin || !project) return
    let cancelled = false
    fetch("/api/v1/projects", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) {
          const all: Project[] = d.items ?? []
          setTeamProjects(all.filter((p) => p.teamId === project.teamId))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isAdmin, project])

  // Aggregate app statuses across the team's projects for the fleet-health card.
  useEffect(() => {
    if (isAdmin || teamProjects.length === 0) {
      setTeamApps([])
      return
    }
    let cancelled = false
    Promise.all(
      teamProjects.map((p) => api.apps.list(p.id).then((r) => r.items).catch(() => [] as App[]))
    ).then((all) => { if (!cancelled) setTeamApps(all.flat()) })
    return () => { cancelled = true }
  }, [isAdmin, teamProjects])

  const activeTeam = teams.find((t) => t.id === selectedTeamId) ?? teams[0]

  const handleSelectTeam = useCallback((id: string) => {
    setSelectedTeamId(id)
    router.push("/dashboard")
  }, [setSelectedTeamId, router])

  // ── header area (h-14, always rendered) ──────────────────────────────────

  const header = (
    <div className={cn("flex items-center gap-2", collapsed ? "justify-center" : "w-full")}>
      <Link href="/dashboard" className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity">
        <CanetteLogo className="size-5 shrink-0" />
        {!collapsed && <span className="text-sm font-semibold tracking-tight">canette</span>}
      </Link>
      {isAdmin && !collapsed && (
        <span className="text-[10.5px] font-medium px-1.5 py-px rounded-sm bg-muted text-muted-foreground">Admin</span>
      )}
      {!collapsed && (
        <button
          type="button"
          onClick={onToggle}
          title="Collapse sidebar"
          className="ml-auto flex items-center justify-center size-6 rounded-md text-tertiary hover:text-foreground hover:bg-muted transition-colors shrink-0"
        >
          <PanelLeftClose size={14} />
        </button>
      )}
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
        <div className="relative">
          <div className="flex items-center">
            <Link
              href="/dashboard"
              title={collapsed ? "All projects" : undefined}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors min-w-0",
                !collapsed && teamProjects.length > 0 ? "rounded-l-md flex-1" : "rounded-md",
                collapsed && "justify-center",
              )}
            >
              <LayoutDashboard size={15} className="shrink-0" />
              {!collapsed && <span className="truncate">Projects</span>}
            </Link>
            {!collapsed && teamProjects.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Switch project"
                    className="group px-1.5 py-1.5 rounded-r-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=open]:bg-muted/50 data-[state=open]:text-foreground"
                  >
                    <ChevronDown size={13} className="transition-transform group-data-[state=open]:rotate-180" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="min-w-[12rem] max-h-60 overflow-y-auto">
                  {teamProjects.map((p) => (
                    <DropdownMenuItem
                      key={p.id}
                      asChild
                      className={cn(p.slug === projectSlug ? "font-medium text-foreground" : "text-muted-foreground")}
                    >
                      <Link href={`/dashboard/projects/${p.slug}`} className="truncate">{p.name}</Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
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
        {!collapsed && (
          <div className="px-3 pb-1 text-[11px] font-medium text-tertiary">Workspace</div>
        )}
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
        {teamId && (
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
        "flex flex-col border-r border-border bg-surface transition-all duration-200 shrink-0",
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
          {collapsed && (
            <button
              type="button"
              onClick={onToggle}
              title="Expand sidebar"
              className="flex items-center justify-center py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <PanelLeftOpen size={14} />
            </button>
          )}
          {nav}
        </div>
      </div>

      {/* Footer: fleet health + appearance */}
      <div className="px-2 py-2 flex flex-col">
        {!collapsed && !isAdmin && <FleetHealth apps={teamApps} />}
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-end px-1")}>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  )
}
