"use client"

import { useState } from "react"
import { useParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { FormError } from "@/components/ui/form-error"
import { Separator } from "@/components/ui/separator"
import { Loader2 } from "lucide-react"
import { ManifestDialog } from "@/components/manifest-dialog"
import { DeploymentRow } from "@/components/deployment-row"
import { DeployActionBar } from "@/components/deploy-action-bar"
import { StopAppDialog } from "@/components/stop-app-dialog"
import { useAppContext } from "@/lib/app-context"
import { useDeploymentActions } from "@/lib/use-deployment-actions"
import { formatHistoricalStatus } from "@/lib/deployment-format"
import type { Deployment } from "@canette/types"

export default function DeploymentsPage() {
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const { app, refresh } = useAppContext()

  const {
    deploymentList,
    loading,
    loadError,
    hasActiveDeployment,
    liveDeployment,
    currentDeployment,
    canRedeploy,
    canRedeployDeployment,
    deploy,
    redeploy,
    stop,
    deploying,
    redeployingId,
    stopping,
    actionError,
  } = useDeploymentActions(app.id, { limit: 50, onSettled: refresh })

  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [manifestDeployment, setManifestDeployment] = useState<Deployment | null>(null)

  async function handleStop() {
    await stop()
    setShowStopConfirm(false)
  }

  const appBase = `/dashboard/projects/${slug}/apps/${appSlug}`

  return (
    <div className="flex flex-col gap-6">
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {loadError && <FormError message={loadError} />}

      <div className="flex gap-2 flex-wrap">
        <DeployActionBar
          sourceType={app.sourceType}
          canRedeploy={canRedeploy}
          currentDeployment={currentDeployment}
          hasActiveDeployment={hasActiveDeployment}
          deploying={deploying}
          redeployingId={redeployingId}
          stopping={stopping}
          onDeploy={deploy}
          onRedeploy={redeploy}
          onStopClick={() => setShowStopConfirm(true)}
        />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="px-6 py-4 flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…
            </div>
          ) : deploymentList.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">No deployments yet.</p>
          ) : (
            deploymentList.map((d, i) => (
              <div key={d.id}>
                {i > 0 && <Separator />}
                <DeploymentRow
                  deployment={d}
                  appBase={appBase}
                  isCurrent={d.id === liveDeployment?.id}
                  formatStatusLabel={formatHistoricalStatus}
                  onManifest={setManifestDeployment}
                  showSbom
                  onRedeploy={redeploy}
                  canRedeploy={canRedeployDeployment(d)}
                  redeploying={redeployingId === d.id}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={showStopConfirm} onOpenChange={(o) => { if (!o) setShowStopConfirm(false) }}>
        <StopAppDialog onConfirm={handleStop} onClose={() => setShowStopConfirm(false)} stopping={stopping} />
      </Dialog>

      <Dialog open={!!manifestDeployment} onOpenChange={(o) => { if (!o) setManifestDeployment(null) }}>
        {manifestDeployment && <ManifestDialog deploymentId={manifestDeployment.id} onClose={() => setManifestDeployment(null)} />}
      </Dialog>
    </div>
  )
}
