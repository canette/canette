"use client"

import { ChevronDown, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { shortSha } from "@/lib/deployment-format"
import type { Deployment } from "@canette/types"

type DeployActionBarProps = {
  sourceType: "git" | "image"
  canRedeploy: boolean
  currentDeployment?: Deployment
  // The newest deployment still being built or rolled out, if any.
  activeDeployment?: Deployment
  deploying: boolean
  redeployingId: string | null
  stopping: boolean
  onDeploy: () => void
  onRedeploy: (deploymentId: string) => void
  onStopClick: () => void
}

/** What the busy Deploy button says while a deployment is on its way. */
function progressLabel(status: string): string {
  if (status === "pending_build") return "Queued…"
  if (status === "building" || status === "scanning") return "Building…"
  return "Deploying…"
}

/** Deploy/Rebuild/Redeploy/Stop buttons — shared by the Overview Status card and the Deployments tab. */
export function DeployActionBar({
  sourceType,
  canRedeploy,
  currentDeployment,
  activeDeployment,
  deploying,
  redeployingId,
  stopping,
  onDeploy,
  onRedeploy,
  onStopClick,
}: DeployActionBarProps) {
  const redeploying = !!currentDeployment && redeployingId === currentDeployment.id
  const stopButton = (
    <Button size="sm" variant="outline" onClick={onStopClick}
      disabled={stopping || !currentDeployment || !(activeDeployment || ["live", "failed"].includes(currentDeployment.status))}>
      Stop
    </Button>
  )

  // While a deployment is on its way, the button shows its progress, as it
  // always has. Starting another one is still possible (it replaces the one
  // in progress, #354) but rarely wanted, so it sits in a menu next to the
  // button rather than behind it.
  if (activeDeployment) {
    const busy = deploying || redeploying
    return (
      <>
        <div className="inline-flex">
          <Button size="sm" disabled className="rounded-r-none">
            <Loader2 className="animate-spin" />
            {busy ? "Starting…" : progressLabel(activeDeployment.status)}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-l-none border-l-0 px-2" disabled={busy}
                aria-label="Start a new deployment instead">
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[17rem]">
              <DropdownMenuItem onSelect={onDeploy}>
                <div>{sourceType === "git" ? "Start a new build" : "Deploy the image again"}</div>
                <div className="text-xs text-muted-foreground">Replaces the deployment in progress</div>
              </DropdownMenuItem>
              {canRedeploy && currentDeployment && (
                <DropdownMenuItem onSelect={() => onRedeploy(currentDeployment.id)}>
                  <div>Redeploy (no rebuild)</div>
                  <div className="text-xs text-muted-foreground">
                    Reuses the image of <span className="font-mono">{shortSha(currentDeployment.commitSha)}</span>, replacing the deployment in progress
                  </div>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {stopButton}
      </>
    )
  }

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
        <Button size="sm" onClick={onDeploy} disabled={deploying}>
          {deploying ? "Deploying…" : "Deploy"}
        </Button>
      )}
      {stopButton}
    </>
  )
}
