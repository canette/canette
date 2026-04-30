"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { ChevronDown, Copy, Check } from "lucide-react"
import { useSession } from "@/lib/auth-client"
import { AppShell } from "@/components/app-shell"
import * as api from "@/lib/api"
import type { AdminProjectOverview, AdminTeamOverview, ResourceDefaults, ScanPolicy, SyncResult, TeamMember, User, UserDeletionImpact, WebhookSettings } from "@canette/types"

// ── helpers ───────────────────────────────────────────────────────────────────

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

// ── main page ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const router = useRouter()
  const { data: session, isPending: sessionLoading } = useSession()

  const [users, setUsers] = useState<User[]>([])
  const [overview, setOverview] = useState<AdminProjectOverview[]>([])
  const [adminTeams, setAdminTeams] = useState<AdminTeamOverview[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // collapsible cards
  const [usersOpen, setUsersOpen] = useState(true)
  const [teamsOpen, setTeamsOpen] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [securityOpen, setSecurityOpen] = useState(false)
  const [webhooksOpen, setWebhooksOpen] = useState(false)

  // scan policy
  const [scanPolicy, setScanPolicy] = useState<ScanPolicy | null>(null)
  const [policyDraft, setPolicyDraft] = useState<ScanPolicy | null>(null)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [policyError, setPolicyError] = useState("")

  // webhook settings (read-only — configured via Helm)
  const [webhookSettings, setWebhookSettings] = useState<WebhookSettings | null>(null)

  // resource defaults (read-only — configured via Helm)
  const [resourcesOpen, setResourcesOpen] = useState(false)
  const [resourceDefaults, setResourceDefaults] = useState<ResourceDefaults | null>(null)

  // per-project expansion in overview
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  // team member management
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set())
  const [teamMembers, setTeamMembers] = useState<Map<string, TeamMember[]>>(new Map())
  const [teamMembersLoading, setTeamMembersLoading] = useState<Set<string>>(new Set())
  const [addMemberTeamId, setAddMemberTeamId] = useState<string | null>(null)
  const [addMemberEmail, setAddMemberEmail] = useState("")
  const [addingMember, setAddingMember] = useState(false)
  const [addMemberError, setAddMemberError] = useState("")

  // user actions
  const [actionError, setActionError] = useState("")
  const [pendingAction, setPendingAction] = useState<string | null>(null) // user id being acted on
  const [deleteConfirm, setDeleteConfirm] = useState<User | null>(null)
  const [deletionImpact, setDeletionImpact] = useState<UserDeletionImpact | null>(null)
  const [deletionImpactLoading, setDeletionImpactLoading] = useState(false)
  const [deleteImpactAcknowledged, setDeleteImpactAcknowledged] = useState(false)
  const [roleToggleConfirm, setRoleToggleConfirm] = useState<User | null>(null)
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState<User | null>(null)
  const [resetPasswordPending, setResetPasswordPending] = useState<string | null>(null)
  const [resetPasswordResult, setResetPasswordResult] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // sync
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncError, setSyncError] = useState("")

  // reset stuck
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<SyncResult | null>(null)
  const [resetError, setResetError] = useState("")

  useEffect(() => {
    if (sessionLoading) return
    const u = session?.user as Record<string, unknown> | undefined
    const role = typeof u?.role === "string" ? u.role : undefined
    if (role !== "admin") {
      router.replace("/dashboard")
      return
    }
    Promise.all([api.admin.listUsers(), api.admin.getOverview(), api.admin.getTeams(), api.admin.getScanPolicy(), api.admin.getWebhookSettings(), api.admin.getResourceDefaults()])
      .then(([u, o, t, p, wh, rd]) => { setUsers(u); setOverview(o); setAdminTeams(t); setScanPolicy(p); setPolicyDraft(p); setWebhookSettings(wh); setResourceDefaults(rd) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [session, sessionLoading, router])

  async function handleRoleToggle(user: User) {
    const newRole = user.role === "admin" ? "developer" : "admin"
    setActionError("")
    setPendingAction(user.id)
    try {
      const updated = await api.admin.updateUserRole(user.id, newRole)
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)))
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to update role")
    } finally {
      setPendingAction(null)
    }
  }

  async function openDeleteConfirm(user: User) {
    setDeleteConfirm(user)
    setDeletionImpact(null)
    setDeleteImpactAcknowledged(false)
    setDeletionImpactLoading(true)
    try {
      const impact = await api.admin.getUserDeletionImpact(user.id)
      setDeletionImpact(impact)
    } catch {
      // impact fetch failed — we'll still show the dialog, delete may fail with a clear error
    } finally {
      setDeletionImpactLoading(false)
    }
  }

  async function handleDelete(userId: string, force: boolean) {
    setActionError("")
    setPendingAction(userId)
    try {
      await api.admin.deleteUser(userId, force)
      setUsers((prev) => prev.filter((u) => u.id !== userId))
      setTeamMembers((prev) => {
        const next = new Map(prev)
        for (const [teamId, members] of next) {
          next.set(teamId, members.filter((m) => m.userId !== userId))
        }
        return next
      })
      setDeleteConfirm(null)
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to delete user")
    } finally {
      setPendingAction(null)
    }
  }

  async function handleResetPassword(userId: string) {
    setActionError("")
    setResetPasswordPending(userId)
    try {
      const { password } = await api.admin.resetUserPassword(userId)
      setResetPasswordResult(password)
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Failed to reset password")
    } finally {
      setResetPasswordPending(null)
    }
  }

  function handleCopy() {
    if (!resetPasswordResult) return
    navigator.clipboard.writeText(resetPasswordResult)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleSync() {
    setSyncError("")
    setSyncResult(null)
    setSyncing(true)
    try {
      const result = await api.admin.sync()
      setSyncResult(result)
    } catch (e: unknown) {
      setSyncError(e instanceof Error ? e.message : "Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  async function handleResetStuck() {
    setResetError("")
    setResetResult(null)
    setResetting(true)
    try {
      const result = await api.admin.resetStuck()
      setResetResult(result)
    } catch (e: unknown) {
      setResetError(e instanceof Error ? e.message : "Reset failed")
    } finally {
      setResetting(false)
    }
  }

  async function handleSavePolicy() {
    if (!policyDraft) return
    setPolicyError("")
    setSavingPolicy(true)
    try {
      const updated = await api.admin.updateScanPolicy(policyDraft)
      setScanPolicy(updated)
      setPolicyDraft(updated)
    } catch (e: unknown) {
      setPolicyError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSavingPolicy(false)
    }
  }

  function toggleProject(id: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function toggleTeam(teamId: string) {
    setExpandedTeams((prev) => {
      const next = new Set(prev)
      if (next.has(teamId)) { next.delete(teamId); return next }
      next.add(teamId)
      return next
    })
    if (!teamMembers.has(teamId)) {
      setTeamMembersLoading((prev) => new Set(prev).add(teamId))
      try {
        const members = await api.admin.getTeamMembers(teamId)
        setTeamMembers((prev) => new Map(prev).set(teamId, members))
      } finally {
        setTeamMembersLoading((prev) => { const next = new Set(prev); next.delete(teamId); return next })
      }
    }
  }

  async function handleAdminAddMember(e: React.FormEvent, teamId: string) {
    e.preventDefault()
    if (!addMemberEmail.trim()) return
    setAddMemberError("")
    setAddingMember(true)
    try {
      await api.teams.addMember(teamId, { email: addMemberEmail.trim() })
      setAddMemberEmail("")
      setAddMemberTeamId(null)
      const members = await api.admin.getTeamMembers(teamId)
      setTeamMembers((prev) => new Map(prev).set(teamId, members))
      setAdminTeams((prev) => prev.map((t) => t.id === teamId ? { ...t, memberCount: members.length } : t))
    } catch (e: unknown) {
      setAddMemberError(e instanceof Error ? e.message : "Failed to add member")
    } finally {
      setAddingMember(false)
    }
  }

  async function handleAdminRemoveMember(teamId: string, userId: string) {
    try {
      await api.teams.removeMember(teamId, userId)
      setTeamMembers((prev) => {
        const updated = (prev.get(teamId) ?? []).filter((m) => m.userId !== userId)
        return new Map(prev).set(teamId, updated)
      })
      setAdminTeams((prev) => prev.map((t) => t.id === teamId ? { ...t, memberCount: t.memberCount - 1 } : t))
    } catch {
      // ignore
    }
  }

  const currentUserId = typeof session?.user?.id === "string" ? session.user.id : undefined

  if (sessionLoading || loading) {
    return (
      <Shell>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </Shell>
    )
  }

  if (error) {
    return (
      <Shell>
        <p className="text-destructive text-sm">{error}</p>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex flex-col gap-6">

        {/* Users */}
        <Collapsible open={usersOpen} onOpenChange={setUsersOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Users <span className="text-muted-foreground font-normal text-sm ml-1">({users.length})</span></CardTitle>
                  <Chevron open={usersOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="p-0">
                {actionError && (
                  <p className="text-sm text-destructive px-6 pb-3">{actionError}</p>
                )}
                {users.length === 0 ? (
                  <p className="text-muted-foreground text-sm px-6 pb-4">No users.</p>
                ) : (
                  users.map((user, i) => (
                    <div key={user.id}>
                      {i > 0 && <Separator />}
                      <div className="flex items-center justify-between px-6 py-3 gap-4">
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium truncate">{user.name}</span>
                          <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={user.role === "admin" ? "live" : "secondary"}>
                            {user.role}
                          </Badge>
                          {user.id === currentUserId ? (
                            <span className="text-xs text-muted-foreground">(you)</span>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => setRoleToggleConfirm(user)}
                                disabled={pendingAction === user.id || resetPasswordPending === user.id}
                              >
                                {user.role === "admin" ? "Make developer" : "Make admin"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground"
                                onClick={() => setResetPasswordConfirm(user)}
                                disabled={pendingAction === user.id || resetPasswordPending === user.id}
                              >
                                Reset password
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                onClick={() => openDeleteConfirm(user)}
                                disabled={pendingAction === user.id || resetPasswordPending === user.id}
                              >
                                Delete
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Teams */}
        <Collapsible open={teamsOpen} onOpenChange={setTeamsOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Teams <span className="text-muted-foreground font-normal text-sm ml-1">({adminTeams.length})</span></CardTitle>
                  <Chevron open={teamsOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="p-0">
                {adminTeams.length === 0 ? (
                  <p className="text-muted-foreground text-sm px-6 pb-4">No teams yet.</p>
                ) : (
                  adminTeams.map((team, i) => {
                    const expanded = expandedTeams.has(team.id)
                    const members = teamMembers.get(team.id)
                    const membersLoading = teamMembersLoading.has(team.id)
                    return (
                      <div key={team.id}>
                        {i > 0 && <Separator />}
                        <button
                          type="button"
                          className="w-full flex items-center gap-4 px-6 py-3 hover:bg-muted/40 transition-colors text-left"
                          onClick={() => toggleTeam(team.id)}
                        >
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <span className="text-sm font-medium truncate">{team.name}</span>
                            {team.isPersonal && (
                              <Badge variant="secondary" className="text-xs font-normal shrink-0">personal</Badge>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground w-16 text-right">{team.memberCount} member{team.memberCount !== 1 ? "s" : ""}</span>
                          <span className="text-xs text-muted-foreground w-20 text-right">{team.projectCount} project{team.projectCount !== 1 ? "s" : ""}</span>
                          <Chevron open={expanded} />
                        </button>
                        {expanded && (
                          <div className="border-t border-border/50 bg-muted/20">
                            {membersLoading && (
                              <p className="text-xs text-muted-foreground px-10 py-3">Loading…</p>
                            )}
                            {!membersLoading && members && members.length > 0 && (
                              members.map((member, j) => (
                                <div key={member.userId}>
                                  {j > 0 && <Separator />}
                                  <div className="flex items-center gap-3 pl-10 pr-6 py-2.5 group">
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm truncate">{member.name}</p>
                                      <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                                    </div>
                                    {!team.isPersonal && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0"
                                        onClick={() => handleAdminRemoveMember(team.id, member.userId)}
                                        title="Remove member"
                                      >
                                        ×
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              ))
                            )}
                            {!membersLoading && members && members.length === 0 && (
                              <p className="text-xs text-muted-foreground pl-10 pr-6 py-2.5">No members.</p>
                            )}
                            {!team.isPersonal && (
                              <div className="pl-10 pr-6 py-3 border-t border-border/50">
                                {addMemberTeamId === team.id ? (
                                  <form onSubmit={(e) => handleAdminAddMember(e, team.id)} className="flex flex-col gap-2">
                                    <div className="flex gap-2 items-center">
                                      <input
                                        type="email"
                                        placeholder="user@example.com"
                                        value={addMemberEmail}
                                        onChange={(e) => setAddMemberEmail(e.target.value)}
                                        className="h-8 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                                        autoFocus
                                      />
                                      <Button type="submit" size="sm" className="h-8" disabled={!addMemberEmail.trim() || addingMember}>
                                        {addingMember ? "Adding…" : "Add"}
                                      </Button>
                                      <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => { setAddMemberTeamId(null); setAddMemberEmail(""); setAddMemberError("") }}>
                                        Cancel
                                      </Button>
                                    </div>
                                    {addMemberError && <p className="text-xs text-destructive">{addMemberError}</p>}
                                  </form>
                                ) : (
                                  <button
                                    type="button"
                                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                    onClick={() => { setAddMemberTeamId(team.id); setAddMemberEmail(""); setAddMemberError("") }}
                                  >
                                    + Add member
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
                <div className="px-6 py-3 border-t border-border/50">
                  <Link href="/dashboard/teams/new" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    + Create team
                  </Link>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Projects overview */}
        <Collapsible open={overviewOpen} onOpenChange={setOverviewOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Projects <span className="text-muted-foreground font-normal text-sm ml-1">({overview.length})</span></CardTitle>
                  <Chevron open={overviewOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="p-0">
                {overview.length === 0 ? (
                  <p className="text-muted-foreground text-sm px-6 pb-4">No projects yet.</p>
                ) : (
                  overview.map((project, i) => (
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
                                  <a
                                    href={`/dashboard/projects/${project.slug}/apps/${app.slug}`}
                                    className="text-sm hover:underline truncate"
                                  >
                                    {app.name}
                                  </a>
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
                                {app.latestDeploymentStatus && (
                                  <Badge variant={statusVariant(app.latestDeploymentStatus)} className="shrink-0">
                                    {app.latestDeploymentStatus}
                                  </Badge>
                                )}
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
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Reconciliation */}
        <Collapsible open={syncOpen} onOpenChange={setSyncOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Reconciliation</CardTitle>
                  <Chevron open={syncOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-4">
                <div>
                  <p className="text-sm font-medium mb-1">Force sync</p>
                  <p className="text-sm text-muted-foreground">
                    Re-queues all currently-live apps for re-reconciliation. The controller will
                    re-apply their Kubernetes manifests (Deployment, Service, HTTPRoute) on its next
                    poll cycle. This is safe and idempotent — if resources are already correct, the
                    re-apply is a no-op. Use this to recover after a cluster outage where running pods
                    were lost but database state still shows apps as live.
                  </p>
                </div>
                {syncError && <p className="text-sm text-destructive">{syncError}</p>}
                {syncResult && <p className="text-sm text-muted-foreground">{syncResult.message}</p>}
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSync} disabled={syncing}>
                    {syncing ? "Syncing…" : "Force sync"}
                  </Button>
                </div>
                <Separator />
                <div>
                  <p className="text-sm font-medium mb-1">Reset stuck builds</p>
                  <p className="text-sm text-muted-foreground">
                    Marks any deployment stuck in <code className="text-xs">building</code> or <code className="text-xs">scanning</code> as
                    failed. Use this after a builder or cluster crash where build jobs were lost but the
                    database still shows deployments in progress. Affected apps can be redeployed immediately.
                  </p>
                </div>
                {resetError && <p className="text-sm text-destructive">{resetError}</p>}
                {resetResult && <p className="text-sm text-muted-foreground">{resetResult.message}</p>}
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={handleResetStuck} disabled={resetting}>
                    {resetting ? "Resetting…" : "Reset stuck builds"}
                  </Button>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Webhooks */}
        <Collapsible open={webhooksOpen} onOpenChange={setWebhooksOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Webhooks</CardTitle>
                  <Chevron open={webhooksOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  Webhook settings are configured via Helm values and cannot be changed at runtime.
                  Set <code className="text-xs">api.webhookBaseUrl</code> in your Helm values to override
                  the base URL used when registering webhooks with git providers.
                </p>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Webhook base URL</p>
                  <p className="font-mono text-sm">
                    {webhookSettings?.baseUrl || <span className="text-muted-foreground">(uses UI hostname)</span>}
                  </p>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Resource defaults */}
        <Collapsible open={resourcesOpen} onOpenChange={setResourcesOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Resource defaults</CardTitle>
                  <Chevron open={resourcesOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                  Default CPU and memory allocations applied to every app deployment when no per-app
                  override is set. Configured via Helm values (<code className="text-xs">api.defaultResources</code>)
                  and cannot be changed at runtime.
                </p>
                {resourceDefaults && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">CPU request</p>
                      <p className="font-mono text-sm">{resourceDefaults.cpuRequest}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">CPU limit</p>
                      <p className="font-mono text-sm">{resourceDefaults.cpuLimit}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Memory request</p>
                      <p className="font-mono text-sm">{resourceDefaults.memoryRequest}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Memory limit</p>
                      <p className="font-mono text-sm">{resourceDefaults.memoryLimit}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        {/* Security */}
        <Collapsible open={securityOpen} onOpenChange={setSecurityOpen}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer select-none">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Security</CardTitle>
                  <Chevron open={securityOpen} />
                </div>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {policyDraft && (
                <CardContent className="flex flex-col gap-5">
                  <div>
                    <p className="text-sm font-medium mb-1">Image scanning (experimental)</p>
                    <p className="text-sm text-muted-foreground mb-3">
                      Run Trivy against each built image before deployment. Generates a CycloneDX SBOM and
                      optionally blocks deployment when findings exceed the configured severity threshold.
                    </p>
                    <div className="flex flex-col gap-4">
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-sm">Enable scanning</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={policyDraft.enabled}
                          onClick={() => setPolicyDraft((d) => d && { ...d, enabled: !d.enabled })}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none ${
                            policyDraft.enabled ? "bg-foreground" : "bg-input"
                          }`}
                        >
                          <span
                            className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                              policyDraft.enabled ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </label>

                      {policyDraft.enabled && (
                        <>
                          <label className="flex items-center justify-between gap-3">
                            <div>
                              <span className="text-sm">Mandatory (blocking)</span>
                              <p className="text-xs text-muted-foreground mt-0.5">Block deployment when scan finds issues above the threshold</p>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={policyDraft.mandatory}
                              onClick={() => setPolicyDraft((d) => d && { ...d, mandatory: !d.mandatory })}
                              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none ${
                                policyDraft.mandatory ? "bg-foreground" : "bg-input"
                              }`}
                            >
                              <span
                                className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                                  policyDraft.mandatory ? "translate-x-4" : "translate-x-0"
                                }`}
                              />
                            </button>
                          </label>

                          {policyDraft.mandatory && (
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <span className="text-sm">Block on severity</span>
                                <p className="text-xs text-muted-foreground mt-0.5">Block deployment when this severity or higher is found</p>
                              </div>
                              <select
                                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                                value={policyDraft.failSeverity}
                                onChange={(e) => setPolicyDraft((d) => d && { ...d, failSeverity: e.target.value as ScanPolicy["failSeverity"] })}
                              >
                                <option value="CRITICAL">CRITICAL</option>
                                <option value="HIGH">HIGH</option>
                                <option value="MEDIUM">MEDIUM</option>
                                <option value="LOW">LOW</option>
                              </select>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {policyError && <p className="text-sm text-destructive">{policyError}</p>}
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={handleSavePolicy}
                      disabled={savingPolicy || JSON.stringify(policyDraft) === JSON.stringify(scanPolicy)}
                    >
                      {savingPolicy ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </CardContent>
              )}
            </CollapsibleContent>
          </Card>
        </Collapsible>

      </div>

      {/* Confirm before changing a user's role */}
      <Dialog open={roleToggleConfirm !== null} onOpenChange={(open) => { if (!open) setRoleToggleConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role?</DialogTitle>
            <DialogDescription>
              {roleToggleConfirm?.role === "admin"
                ? <>Remove admin privileges from <strong>{roleToggleConfirm?.name}</strong>? They will become a developer.</>
                : <>Grant admin privileges to <strong>{roleToggleConfirm?.name}</strong>? They will be able to manage users and system settings.</>
              }
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleToggleConfirm(null)}>Cancel</Button>
            <Button
              disabled={pendingAction === roleToggleConfirm?.id}
              onClick={() => {
                if (!roleToggleConfirm) return
                setRoleToggleConfirm(null)
                handleRoleToggle(roleToggleConfirm)
              }}
            >
              {roleToggleConfirm?.role === "admin" ? "Make developer" : "Make admin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before deleting a user */}
      <Dialog open={deleteConfirm !== null} onOpenChange={(open) => { if (!open) { setDeleteConfirm(null); setDeletionImpact(null); setDeleteImpactAcknowledged(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user?</DialogTitle>
            <DialogDescription asChild>
              <div>
                <span>Permanently delete <strong>{deleteConfirm?.name}</strong> ({deleteConfirm?.email}).</span>
                {deletionImpactLoading && (
                  <span className="block mt-2 text-xs text-muted-foreground">Checking account data…</span>
                )}
                {!deletionImpactLoading && deletionImpact && (
                  <>
                    {deletionImpact.sharedTeamsReowned.length > 0 && (
                      <span className="block mt-2 text-xs text-muted-foreground">
                        Ownership of {deletionImpact.sharedTeamsReowned.length === 1 ? "team" : "teams"} <strong>{deletionImpact.sharedTeamsReowned.join(", ")}</strong> will be transferred to you.
                      </span>
                    )}
                    {deletionImpact.personalTeam && deletionImpact.personalTeam.inFlightAppNames.length > 0 && (
                      <span className="block mt-2 text-sm text-destructive">
                        Cannot delete: {deletionImpact.personalTeam.inFlightAppNames.length === 1 ? "app" : "apps"} <strong>{deletionImpact.personalTeam.inFlightAppNames.join(", ")}</strong> {deletionImpact.personalTeam.inFlightAppNames.length === 1 ? "is" : "are"} currently building or deploying. Stop {deletionImpact.personalTeam.inFlightAppNames.length === 1 ? "it" : "them"} first.
                      </span>
                    )}
                    {deletionImpact.personalTeam && deletionImpact.personalTeam.inFlightAppNames.length === 0 && deletionImpact.personalTeam.projectCount > 0 && (
                      <span className="block mt-2 text-sm text-amber-600 dark:text-amber-500">
                        This will permanently delete {deletionImpact.personalTeam.projectCount} project{deletionImpact.personalTeam.projectCount !== 1 ? "s" : ""} and {deletionImpact.personalTeam.appCount} app{deletionImpact.personalTeam.appCount !== 1 ? "s" : ""}. Running apps will be stopped. Kubernetes resources will be cleaned up in the background.
                      </span>
                    )}
                  </>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          {!deletionImpactLoading && deletionImpact?.personalTeam && deletionImpact.personalTeam.inFlightAppNames.length === 0 && deletionImpact.personalTeam.projectCount > 0 && (
            <label className="flex items-center gap-2 px-6 text-sm cursor-pointer select-none">
              <Checkbox
                checked={deleteImpactAcknowledged}
                onCheckedChange={(v) => setDeleteImpactAcknowledged(v === true)}
              />
              I understand all projects and apps will be permanently deleted
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteConfirm(null); setDeletionImpact(null); setDeleteImpactAcknowledged(false) }}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={
                pendingAction === deleteConfirm?.id ||
                deletionImpactLoading ||
                !!(deletionImpact?.personalTeam?.inFlightAppNames.length) ||
                !!(deletionImpact?.personalTeam && deletionImpact.personalTeam.projectCount > 0 && !deleteImpactAcknowledged)
              }
              onClick={() => {
                if (!deleteConfirm) return
                const force = !!(deletionImpact?.personalTeam && deletionImpact.personalTeam.projectCount > 0)
                handleDelete(deleteConfirm.id, force)
              }}
            >
              {pendingAction === deleteConfirm?.id ? "Deleting…" : "Delete user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before resetting a user's password */}
      <Dialog open={resetPasswordConfirm !== null} onOpenChange={(open) => { if (!open) setResetPasswordConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password?</DialogTitle>
            <DialogDescription>
              This will generate a new password for <strong>{resetPasswordConfirm?.name}</strong> ({resetPasswordConfirm?.email}) and invalidate their current one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetPasswordConfirm(null)}>Cancel</Button>
            <Button
              disabled={resetPasswordPending === resetPasswordConfirm?.id}
              onClick={() => {
                if (!resetPasswordConfirm) return
                setResetPasswordConfirm(null)
                handleResetPassword(resetPasswordConfirm.id)
              }}
            >
              {resetPasswordPending === resetPasswordConfirm?.id ? "Resetting…" : "Reset password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time password display — shown after a successful reset */}
      <Dialog open={resetPasswordResult !== null} onOpenChange={(open) => { if (!open) { setResetPasswordResult(null); setCopied(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>
              This password will not be shown again. Share it securely with the user and ask them to change it after signing in.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-input bg-muted px-3 py-2 mx-6 mb-2">
            <code className="flex-1 font-mono text-sm select-all">{resetPasswordResult}</code>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" onClick={handleCopy}>
              {copied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => { setResetPasswordResult(null); setCopied(false) }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell breadcrumb={[{ label: "Admin" }]}>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">User management and system operations.</p>
      </div>
      {children}
    </AppShell>
  )
}
