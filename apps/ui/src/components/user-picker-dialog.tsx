"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { UserAvatar } from "@/components/ui/user-avatar"
import * as api from "@/lib/api"
import type { User } from "@canette/types"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  teamId: string
  existingMemberIds: Set<string>
  onMemberAdded: () => void
}

export function UserPickerDialog({ open, onOpenChange, teamId, existingMemberIds, onMemberAdded }: Props) {
  const [users, setUsers] = useState<User[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [search, setSearch] = useState("")
  const [addingUserId, setAddingUserId] = useState<string | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setSearch("")
    setError("")
    setLoadingUsers(true)
    api.admin.listUsers()
      .then(setUsers)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load users"))
      .finally(() => setLoadingUsers(false))
  }, [open])

  const filtered = users
    .filter((u) => !existingMemberIds.has(u.id))
    .filter((u) => {
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    })
  const available = filtered.slice(0, 50)
  const overflow = filtered.length - available.length

  async function handleAdd(user: User) {
    setAddingUserId(user.id)
    setError("")
    try {
      await api.admin.addTeamMember(teamId, { userId: user.id })
      onMemberAdded()
      onOpenChange(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to add member")
    } finally {
      setAddingUserId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-6">
          <Input
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          {loadingUsers && (
            <p className="text-sm text-muted-foreground py-2">Loading…</p>
          )}
          {!loadingUsers && available.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">
              {search.trim() ? "No users match your search." : "All registered users are already members."}
            </p>
          )}
          {!loadingUsers && available.length > 0 && (
            <div className="max-h-72 overflow-y-auto -mx-6">
              {available.map((user, i) => (
                <div key={user.id}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center gap-3 px-6 py-2.5 hover:bg-muted/40">
                    <UserAvatar name={user.name} image={user.image} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{user.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0"
                      disabled={addingUserId !== null}
                      onClick={() => handleAdd(user)}
                    >
                      {addingUserId === user.id ? "Adding…" : "Add"}
                    </Button>
                  </div>
                </div>
              ))}
              {overflow > 0 && (
                <p className="text-xs text-muted-foreground px-6 py-2.5 border-t border-border/50">
                  {overflow} more — type to narrow results
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
