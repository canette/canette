"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { FormError } from "@/components/ui/form-error"
import * as api from "@/lib/api"
import type { AppPasswordGate } from "@canette/types"

// Team-scoped password protection for a single web app's public URL, gated with
// HTTP Basic Auth via a Caddy sidecar in the app's own pod. Unlike custom
// hostnames this is an operational per-app setting, not a DNS/TLS authority
// grant, so it's not admin-gated.
export function PasswordGateManager({ appId }: { appId: string }) {
  const [gate, setGate] = useState<AppPasswordGate>({ enabled: false })
  const [loading, setLoading] = useState(true)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")

  const [disableOpen, setDisableOpen] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [disableError, setDisableError] = useState("")

  const loadGate = useCallback(async () => {
    setLoading(true)
    try {
      const status = await api.passwordGate.get(appId)
      setGate(status)
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [appId])

  useEffect(() => { loadGate() }, [loadGate])

  function openDialog() {
    setUsername(gate.username ?? "")
    setPassword("")
    setSaveError("")
    setDialogOpen(true)
  }

  async function handleSave() {
    setSaveError("")
    setSaving(true)
    try {
      const status = await api.passwordGate.enable(appId, username.trim(), password)
      setGate(status)
      setDialogOpen(false)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Failed to save credentials")
    } finally { setSaving(false) }
  }

  async function handleDisable() {
    setDisableError("")
    setDisabling(true)
    try {
      const status = await api.passwordGate.disable(appId)
      setGate(status)
      setDisableOpen(false)
    } catch (e: unknown) {
      setDisableError(e instanceof Error ? e.message : "Failed to disable password protection")
    } finally { setDisabling(false) }
  }

  if (loading) return <Skeleton className="h-4 w-40" />

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Requires a username and password (HTTP Basic Auth) before the app&apos;s public URL is
        reachable. Changes take effect on the next deployment.
      </p>

      {gate.enabled ? (
        <div className="flex items-center gap-3 rounded-md border px-4 py-3">
          <div className="flex-1 min-w-0">
            <span className="text-sm font-mono">{gate.username}</span>
          </div>
          <Button size="sm" variant="outline" onClick={openDialog}>Change credentials</Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive"
            onClick={() => { setDisableError(""); setDisableOpen(true) }}>
            Disable
          </Button>
        </div>
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={openDialog}>Enable password protection</Button>
        </div>
      )}

      {/* Enable/change credentials dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{gate.enabled ? "Change credentials" : "Enable password protection"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gate-username">Username</Label>
              <Input id="gate-username" value={username} onChange={(e) => setUsername(e.target.value)}
                className="font-mono text-sm" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gate-password">Password</Label>
              <Input id="gate-password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} className="font-mono text-sm" />
            </div>
            {saveError && <FormError message={saveError} />}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !username.trim() || !password}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Disable confirmation dialog */}
      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable password protection</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-6 pb-6">
            <p className="text-sm text-muted-foreground">
              The public URL will become reachable without a username or password.
            </p>
            {disableError && <FormError message={disableError} />}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDisableOpen(false)} disabled={disabling}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={disabling} onClick={handleDisable}>
                {disabling ? "Disabling…" : "Disable"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
