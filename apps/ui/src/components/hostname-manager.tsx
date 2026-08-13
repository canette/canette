"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Trash2 } from "lucide-react"
import * as api from "@/lib/api"
import type { AppHostname } from "@canette/types"

// Admin-only custom hostname CRUD, shared between the app settings page
// (apps/[appSlug]/settings) and the admin projects overview — the latter exists
// because the settings page route is team-scoped and 404s for an admin who isn't
// a member of the app's team, while the /apps/:id/hostnames API itself is not.
export function HostnameManager({ appId }: { appId: string }) {
  const [hostnames, setHostnames] = useState<AppHostname[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")

  const [addHostname, setAddHostname] = useState("")
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState("")

  const loadHostnames = useCallback(async () => {
    setLoading(true)
    try {
      const { items } = await api.hostnames.list(appId)
      setHostnames(items)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [appId])

  useEffect(() => { loadHostnames() }, [loadHostnames])

  async function handleAdd() {
    setAddError("")
    setAdding(true)
    try {
      await api.hostnames.create(appId, addHostname.trim())
      setAddHostname("")
      setDialogOpen(false)
      await loadHostnames()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : "Failed to add hostname")
    } finally { setAdding(false) }
  }

  async function handleDelete(id: string) {
    setDeleting(true); setDeleteError("")
    try {
      await api.hostnames.delete(appId, id)
      setDeleteId(null)
      await loadHostnames()
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete hostname")
    } finally { setDeleting(false) }
  }

  const hostToDelete = hostnames.find((h) => h.id === deleteId)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Hostname changes (add, remove) take effect on the next deployment. Trigger a
        redeploy after changes to see them applied to the app&apos;s HTTPRoute.
        canette does not provision TLS certificates for custom domains — ensure your
        Gateway already has a matching certificate before adding one here.
      </p>

      {loading ? (
        <Skeleton className="h-4 w-40" />
      ) : hostnames.length > 0 ? (
        <div className="flex flex-col divide-y divide-border border rounded-md">
          {hostnames.map((h) => (
            <div key={h.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <span className="text-sm font-mono">{h.hostname}</span>
              </div>
              <Button size="sm" variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => { setDeleteId(h.id); setDeleteError("") }}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No custom hostnames configured.</p>
      )}

      <div>
        <Button size="sm" variant="outline" onClick={() => { setAddHostname(""); setAddError(""); setDialogOpen(true) }}>
          Add hostname
        </Button>
      </div>

      {/* Add hostname dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add custom hostname</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hostname-input">Hostname</Label>
              <Input id="hostname-input" placeholder="app.example.com" value={addHostname}
                onChange={(e) => setAddHostname(e.target.value)}
                className="font-mono text-sm" />
            </div>
            {addError && <p className="text-sm text-destructive">{addError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} disabled={adding || !addHostname.trim()}>
                {adding ? "Adding…" : "Add hostname"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove hostname</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            <p className="text-sm text-muted-foreground">
              Remove <code className="text-xs font-mono">{hostToDelete?.hostname}</code> from this app?
            </p>
            {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteId(null)} disabled={deleting}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={deleting}
                onClick={() => deleteId && handleDelete(deleteId)}>
                {deleting ? "Removing…" : "Remove hostname"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
