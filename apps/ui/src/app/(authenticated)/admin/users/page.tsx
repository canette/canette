"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Copy, Check } from "lucide-react"
import { useSession } from "@/lib/auth-client"
import { FormError } from "@/components/ui/form-error"
import * as api from "@/lib/api"
import type { User, UserDeletionImpact } from "@canette/types"

export default function AdminUsersPage() {
  const { data: session } = useSession()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const [actionError, setActionError] = useState("")
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  const [deleteConfirm, setDeleteConfirm] = useState<User | null>(null)
  const [deletionImpact, setDeletionImpact] = useState<UserDeletionImpact | null>(null)
  const [deletionImpactLoading, setDeletionImpactLoading] = useState(false)
  const [deleteImpactAcknowledged, setDeleteImpactAcknowledged] = useState(false)

  const [roleToggleConfirm, setRoleToggleConfirm] = useState<User | null>(null)
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState<User | null>(null)
  const [resetPasswordPending, setResetPasswordPending] = useState<string | null>(null)
  const [resetPasswordResult, setResetPasswordResult] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api.admin.listUsers()
      .then(setUsers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

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
      // impact fetch failed — dialog still shows, delete may fail with a clear error
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

  const currentUserId = typeof session?.user?.id === "string" ? session.user.id : undefined

  if (loading) return <p className="text-muted-foreground text-sm">Loading…</p>
  if (error) return <p className="text-destructive text-sm">{error}</p>

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage user accounts and roles.</p>
      </div>

      {actionError && <div className="mb-4"><FormError message={actionError} /></div>}

      <div className="rounded-lg border border-border">
        {users.length === 0 ? (
          <p className="text-muted-foreground text-sm px-6 py-4">No users.</p>
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
                  <Badge variant={user.role === "admin" ? "live" : "secondary"}>{user.role}</Badge>
                  {user.id === currentUserId ? (
                    <span className="text-xs text-muted-foreground">(you)</span>
                  ) : (
                    <>
                      <Button
                        size="sm" variant="outline" className="h-7 px-2 text-xs"
                        onClick={() => setRoleToggleConfirm(user)}
                        disabled={pendingAction === user.id || resetPasswordPending === user.id}
                      >
                        {user.role === "admin" ? "Make developer" : "Make admin"}
                      </Button>
                      {user.hasPassword && (
                        <Button
                          size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground"
                          onClick={() => setResetPasswordConfirm(user)}
                          disabled={pendingAction === user.id || resetPasswordPending === user.id}
                        >
                          Reset password
                        </Button>
                      )}
                      <Button
                        size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
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
      </div>

      {/* Role toggle */}
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
              onClick={() => { if (!roleToggleConfirm) return; setRoleToggleConfirm(null); handleRoleToggle(roleToggleConfirm) }}
            >
              {roleToggleConfirm?.role === "admin" ? "Make developer" : "Make admin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete user */}
      <Dialog open={deleteConfirm !== null} onOpenChange={(open) => { if (!open) { setDeleteConfirm(null); setDeletionImpact(null); setDeleteImpactAcknowledged(false) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user?</DialogTitle>
            <DialogDescription asChild>
              <div>
                <span>Permanently delete <strong>{deleteConfirm?.name}</strong> ({deleteConfirm?.email}).</span>
                {deletionImpactLoading && <span className="block mt-2 text-xs text-muted-foreground">Checking account data…</span>}
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
              <Checkbox checked={deleteImpactAcknowledged} onCheckedChange={(v) => setDeleteImpactAcknowledged(v === true)} />
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

      {/* Reset password confirm */}
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

      {/* One-time password display */}
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
    </>
  )
}
