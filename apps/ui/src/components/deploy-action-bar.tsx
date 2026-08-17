"use client"

import { Button } from "@/components/ui/button"
import type { Deployment } from "@canette/types"

type DeployActionBarProps = {
  sourceType: "git" | "image"
  canRedeploy: boolean
  currentDeployment?: Deployment
  hasActiveDeployment: boolean
  deploying: boolean
  redeployingId: string | null
  stopping: boolean
  onDeploy: () => void
  onRedeploy: (deploymentId: string) => void
  onStopClick: () => void
}

/** Deploy/Rebuild/Redeploy/Stop buttons — shared by the Overview Status card and the Deployments tab. */
export function DeployActionBar({
  sourceType,
  canRedeploy,
  currentDeployment,
  hasActiveDeployment,
  deploying,
  redeployingId,
  stopping,
  onDeploy,
  onRedeploy,
  onStopClick,
}: DeployActionBarProps) {
  const redeploying = !!currentDeployment && redeployingId === currentDeployment.id

  return (
    <>
      {canRedeploy ? (
        <>
          <Button size="sm" onClick={onDeploy} disabled={deploying}>
            {deploying
              ? (sourceType === "git" ? "Rebuilding…" : "Deploying…")
              : (sourceType === "git" ? "Rebuild" : "Deploy new")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => currentDeployment && onRedeploy(currentDeployment.id)} disabled={redeploying}>
            {redeploying ? "Redeploying…" : "Redeploy (no rebuild)"}
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={onDeploy} disabled={deploying || hasActiveDeployment}>
          {deploying ? "Deploying…" : hasActiveDeployment ? "In progress…" : "Deploy"}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={onStopClick}
        disabled={stopping || !currentDeployment || !["live", "failed"].includes(currentDeployment.status)}>
        Stop
      </Button>
    </>
  )
}
