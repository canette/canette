"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ChevronDown } from "lucide-react"
import * as api from "@/lib/api"
import type { AdminTeamOverview, TeamMember } from "@canette/types"

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronDown
      size={16}
      className={`text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
    />
  )
}

export default function AdminTeamsPage() {
  const [adminTeams, setAdminTeams] = useState<AdminTeamOverview[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set())
  const [teamMembers, setTeamMembers] = useState<Map<string, TeamMember[]>>(new Map())
  const [teamMembersLoading, setTeamMembersLoading] = useState<Set<string>>(new Set())

  const [addMemberTeamId, setAddMemberTeamId] = useState<string | null>(null)
  const [addMemberEmail, setAddMemberEmail] = useState("")
  const [addingMember, setAddingMember] = useState(false)
  const [addMemberError, setAddMemberError] = useState("")

  const [deleteTeamConfirm, setDeleteTeamConfirm] = useState<AdminTeamOverview | null>(null)
  const [deletingTeam, setDeletingTeam] = useState(false)
  const [deleteTeamError, setDeleteTeamError] = useState("")

  const [renameTeamTarget, setRenameTeamTarget] = useState<AdminTeamOverview | null>(null)
  const [renameTeamName, setRenameTeamName] = useState("")
  const [renamingTeam, setRenamingTeam] = useState(false)
  const [renameTeamError, setRenameTeamError] = useState("")

  useEffect(() => {
    api.admin.getTeams()
      .then(setAdminTeams)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

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

  async function handleDeleteTeam() {
    if (!deleteTeamConfirm) return
    setDeleteTeamError("")
    setDeletingTeam(true)
    try {
      await api.teams.delete(deleteTeamConfirm.id)
      setAdminTeams((prev) => prev.filter((t) => t.id !== deleteTeamConfirm.id))
      setDeleteTeamConfirm(null)
    } catch (e: unknown) {
      setDeleteTeamError(e instanceof Error ? e.message : "Failed to delete team")
    } finally {
      setDeletingTeam(false)
    }
  }

  async function handleRenameTeam(e: React.FormEvent) {
    e.preventDefault()
    if (!renameTeamTarget || !renameTeamName.trim()) return
    setRenameTeamError("")
    setRenamingTeam(true)
    try {
      await api.teams.rename(renameTeamTarget.id, renameTeamName.trim())
      setAdminTeams((prev) => prev.map((t) => t.id === renameTeamTarget.id ? { ...t, name: renameTeamName.trim() } : t))
      setRenameTeamTarget(null)
    } catch (e: unknown) {
      setRenameTeamError(e instanceof Error ? e.message : "Failed to rename team")
    } finally {
      setRenamingTeam(false)
    }
  }

  function TeamRow({ team }: { team: AdminTeamOverview }) {
    const expanded = expandedTeams.has(team.id)
    const members = teamMembers.get(team.id)
    const membersLoading = teamMembersLoading.has(team.id)
    return (
      <div>
        <button
          type="button"
          className="w-full flex items-center gap-4 px-6 py-3 hover:bg-muted/40 transition-colors text-left"
          onClick={() => toggleTeam(team.id)}
        >
          <span className="text-sm font-medium truncate flex-1 min-w-0">{team.name}</span>
          <span className="text-xs text-muted-foreground w-16 text-right">{team.memberCount} member{team.memberCount !== 1 ? "s" : ""}</span>
          <span className="text-xs text-muted-foreground w-20 text-right">{team.projectCount} project{team.projectCount !== 1 ? "s" : ""}</span>
          <Chevron open={expanded} />
        </button>
        {expanded && (
          <div className="border-t border-border/50 bg-muted/20">
            {membersLoading && <p className="text-xs text-muted-foreground px-10 py-3">Loading…</p>}
            {!membersLoading && members && members.length > 0 && members.map((member, j) => (
              <div key={member.userId}>
                {j > 0 && <Separator />}
                <div className="flex items-center gap-3 pl-10 pr-6 py-2.5 group">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{member.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  </div>
                  {!team.isPersonal && (
                    <Button
                      size="sm" variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 shrink-0"
                      onClick={() => handleAdminRemoveMember(team.id, member.userId)}
                      title="Remove member"
                    >
                      ×
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {!membersLoading && members && members.length === 0 && (
              <p className="text-xs text-muted-foreground pl-10 pr-6 py-2.5">No members.</p>
            )}
            {!team.isPersonal && (
              <div className="pl-10 pr-6 py-2 border-t border-border/50 flex items-center justify-between">
                <div className="flex-1">
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
                <div className="flex items-center gap-1">
                  <Button
                    size="sm" variant="ghost"
                    className="h-7 text-xs text-muted-foreground hover:text-foreground shrink-0"
                    onClick={() => { setRenameTeamError(""); setRenameTeamName(team.name); setRenameTeamTarget(team) }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="h-7 text-xs text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => { setDeleteTeamError(""); setDeleteTeamConfirm(team) }}
                  >
                    Delete team
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error) return <p className="text-destructive text-sm">{error}</p>

  const regularTeams = adminTeams.filter((t) => !t.isPersonal)
  const personalTeams = adminTeams.filter((t) => t.isPersonal)

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Teams</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage teams and their members.</p>
      </div>

      <div className="rounded-lg border border-border">
        <Tabs defaultValue="teams">
          <div className="px-6 border-b border-border">
            <TabsList className="h-auto bg-transparent p-0 gap-0 rounded-none">
              <TabsTrigger value="teams" className="h-10 px-4 rounded-none bg-transparent border-b-2 border-transparent text-sm font-normal text-muted-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none">
                Teams <span className="ml-1.5 text-xs">({regularTeams.length})</span>
              </TabsTrigger>
              <TabsTrigger value="personal" className="h-10 px-4 rounded-none bg-transparent border-b-2 border-transparent text-sm font-normal text-muted-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:shadow-none">
                Personal <span className="ml-1.5 text-xs">({personalTeams.length})</span>
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="teams" className="mt-0">
            {regularTeams.length === 0 ? (
              <div className="px-6 py-4 flex flex-col gap-1">
                <p className="text-muted-foreground text-sm">No teams yet.</p>
                <Link href="/admin/teams/new" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                  + Create team
                </Link>
              </div>
            ) : (
              <>
                {regularTeams.map((team, i) => (
                  <div key={team.id}>
                    {i > 0 && <Separator />}
                    <TeamRow team={team} />
                  </div>
                ))}
                <div className="px-6 py-3 border-t border-border/50">
                  <Link href="/admin/teams/new" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    + Create team
                  </Link>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="personal" className="mt-0">
            {personalTeams.length === 0 ? (
              <p className="text-muted-foreground text-sm px-6 py-4">No personal teams.</p>
            ) : (
              personalTeams.map((team, i) => (
                <div key={team.id}>
                  {i > 0 && <Separator />}
                  <TeamRow team={team} />
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={renameTeamTarget !== null} onOpenChange={(open) => { if (!open) setRenameTeamTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename team</DialogTitle>
            <DialogDescription>Update the display name for this team.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRenameTeam} className="flex flex-col gap-4 px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rename-team-name">Team name</Label>
              <Input
                id="rename-team-name"
                value={renameTeamName}
                onChange={(e) => setRenameTeamName(e.target.value)}
                autoFocus
              />
            </div>
            {renameTeamError && <p className="text-sm text-destructive">{renameTeamError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameTeamTarget(null)} disabled={renamingTeam}>Cancel</Button>
              <Button type="submit" disabled={!renameTeamName.trim() || renameTeamName === renameTeamTarget?.name || renamingTeam}>
                {renamingTeam ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTeamConfirm !== null} onOpenChange={(open) => { if (!open) setDeleteTeamConfirm(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete team</DialogTitle>
            <DialogDescription>
              Permanently delete <strong>{deleteTeamConfirm?.name}</strong>? This will also delete all its projects. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteTeamError && (
            <div className="flex items-center gap-2 rounded-md border border-input bg-muted px-3 py-2 mx-6 mb-2">
              <p className="text-sm text-destructive">{deleteTeamError}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTeamConfirm(null)} disabled={deletingTeam}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteTeam} disabled={deletingTeam}>
              {deletingTeam ? "Deleting…" : "Delete team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
