"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import * as api from "@/lib/api"
import type { SyncResult } from "@canette/types"

export default function AdminReconciliationPage() {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncError, setSyncError] = useState("")

  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<SyncResult | null>(null)
  const [resetError, setResetError] = useState("")

  async function handleSync() {
    setSyncError("")
    setSyncResult(null)
    setSyncing(true)
    try {
      setSyncResult(await api.admin.sync())
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
      setResetResult(await api.admin.resetStuck())
    } catch (e: unknown) {
      setResetError(e instanceof Error ? e.message : "Reset failed")
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Reconciliation</h1>
        <p className="text-sm text-muted-foreground mt-1">Manual cluster reconciliation and recovery tools.</p>
      </div>

      <div className="rounded-lg border border-border divide-y divide-border">
        <div className="p-6 flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium mb-1">Force sync</p>
            <p className="text-sm text-muted-foreground">
              Re-queues all currently-live apps for re-reconciliation. The controller will re-apply their
              Kubernetes manifests (Deployment, Service, HTTPRoute) on its next poll cycle. This is safe
              and idempotent — if resources are already correct, the re-apply is a no-op. Use this to
              recover after a cluster outage where running pods were lost but database state still shows
              apps as live.
            </p>
          </div>
          {syncError && <p className="text-sm text-destructive">{syncError}</p>}
          {syncResult && <p className="text-sm text-muted-foreground">{syncResult.message}</p>}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? "Syncing…" : "Force sync"}
            </Button>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium mb-1">Reset stuck builds</p>
            <p className="text-sm text-muted-foreground">
              Marks any deployment stuck in <code className="text-xs">building</code> or{" "}
              <code className="text-xs">scanning</code> as failed. Use this after a builder or cluster
              crash where build jobs were lost but the database still shows deployments in progress.
              Affected apps can be redeployed immediately.
            </p>
          </div>
          {resetError && <p className="text-sm text-destructive">{resetError}</p>}
          {resetResult && <p className="text-sm text-muted-foreground">{resetResult.message}</p>}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={handleResetStuck} disabled={resetting}>
              {resetting ? "Resetting…" : "Reset stuck builds"}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
