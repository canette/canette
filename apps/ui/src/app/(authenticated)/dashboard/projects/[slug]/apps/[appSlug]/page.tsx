"use client"

import { useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Dialog } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Info } from "lucide-react"
import { StatusBadge } from "@/components/ui/status-badge"
import { Skeleton, SkeletonText } from "@/components/ui/skeleton"
import { AppMetricsSummary } from "@/components/app-metrics-summary"
import { DeploymentRow } from "@/components/deployment-row"
import { DeployActionBar } from "@/components/deploy-action-bar"
import { StopAppDialog } from "@/components/stop-app-dialog"
import { FormError } from "@/components/ui/form-error"
import { useAppContext } from "@/lib/app-context"
import { useDeploymentActions } from "@/lib/use-deployment-actions"
import { shortSha, timeAgo, formatHistoricalStatus } from "@/lib/deployment-format"

export default function AppOverviewPage() {
  const { slug: projectSlug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const { app, project, refresh } = useAppContext()

  const {
    deploymentList,
    loading: loadingDeps,
    loadError: loadDepsError,
    hasActiveDeployment,
    liveDeployment,
    latestDeployment,
    currentDeployment,
    canRedeploy,
    deploy,
    redeploy,
    stop,
    deploying,
    redeployingId,
    stopping,
    actionError,
  } = useDeploymentActions(app.id, { onSettled: refresh })

  const [showStopConfirm, setShowStopConfirm] = useState(false)

  const showLatestBuildRow = !!(liveDeployment && latestDeployment && latestDeployment.id !== liveDeployment.id)

  async function handleStop() {
    await stop()
    setShowStopConfirm(false)
  }

  const appBase = `/dashboard/projects/${projectSlug}/apps/${appSlug}`
  const sourceSummary = app.sourceType === "git"
    ? [app.gitUrl.replace(/^https?:\/\//, ""), app.gitBranch, app.appPath].filter(Boolean).join(" · ")
    : `${app.imageUrl}${app.imageTag ? `:${app.imageTag}` : ""}`

  return (
    <div className="flex flex-col gap-6">
      <AppMetricsSummary appId={app.id} />

      {/* Status card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          {loadingDeps ? (
            <Skeleton className="h-4 w-40 mt-0.5" />
          ) : currentDeployment ? (
            <CardDescription>
              <span className="font-mono">{shortSha(currentDeployment.commitSha)}</span>
              {currentDeployment.commitMessage && ` — ${currentDeployment.commitMessage}`}
              <span className="ml-2 text-xs">{timeAgo(currentDeployment.createdAt)}</span>
            </CardDescription>
          ) : (
            <CardDescription>Not deployed yet</CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loadDepsError && <FormError message={loadDepsError} />}
          {loadingDeps ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
                <SkeletonText lines={2} />
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-8 w-20 rounded-md" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            </div>
          ) : (
            <>
              {actionError && <p className="text-sm text-destructive">{actionError}</p>}
              {!currentDeployment && (
                <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
                  <p className="text-xs text-muted-foreground">
                    This app hasn't been deployed yet. {app.sourceType === "git"
                      ? "Deploy will clone your repo, build it, and publish it."
                      : "Deploy will pull your image and publish it."} Most first deploys finish in 40–90s.
                  </p>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground text-xs shrink-0">{app.sourceType === "git" ? "Source" : "Image"}</span>
                    <span className="font-mono truncate">{sourceSummary}</span>
                  </div>
                  {app.deploymentType !== "cronjob" && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground text-xs shrink-0">Port</span>
                      <span className="font-mono">{app.port}</span>
                    </div>
                  )}
                </div>
              )}
              {currentDeployment?.status === "failed" && currentDeployment.errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
                  <p className="text-xs font-medium text-destructive mb-1">Build failed</p>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{currentDeployment.errorMessage}</p>
                </div>
              )}
              {app.deploymentType === "private" && app.liveUrl && (
                <div className="flex items-start gap-2 rounded-md bg-warning-soft ring-1 ring-inset ring-warning-line px-3 py-2.5">
                  <Info size={14} className="text-warning-text shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    This app still has a <a href={app.liveUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">public URL</a> from a previous deployment. Redeploy to remove it and switch fully to private mode.
                  </p>
                </div>
              )}
              {liveDeployment && app.deploymentType === "private" && (
                <div className="flex items-center gap-2 w-fit rounded-md border border-border px-3 py-1.5 text-sm font-mono text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                  {app.slug}.can-{app.projectId.slice(0, 8)}-{project.slug}.svc.cluster.local
                </div>
              )}
              {app.deploymentType === "cronjob" && app.schedule && (
                <div className="flex items-center gap-2 w-fit rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">
                  <span className="text-xs">Schedule:</span>
                  <code className="font-mono text-foreground">{app.schedule}</code>
                </div>
              )}
              {showLatestBuildRow && latestDeployment && (
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">
                    <span className="font-mono">{shortSha(latestDeployment.commitSha)}</span>
                    {latestDeployment.commitMessage && <span className="ml-2">{latestDeployment.commitMessage}</span>}
                    <span className="ml-2 text-xs">{timeAgo(latestDeployment.createdAt)}</span>
                  </span>
                  <StatusBadge status={latestDeployment.status} label={formatHistoricalStatus(latestDeployment.status)} />
                </div>
              )}
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
                {latestDeployment && (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`${appBase}/logs?mode=build&deployment=${latestDeployment.id}`}>Deploy logs</Link>
                  </Button>
                )}
                {currentDeployment?.status === "live" && (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`${appBase}/logs?mode=runtime`}>
                      {app.deploymentType === "cronjob" ? "Last run logs" : "App logs"}
                    </Link>
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent deployments */}
      {!loadingDeps && deploymentList.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Recent deployments</CardTitle>
              <Link href={`${appBase}/deployments`} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                View all
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {deploymentList.map((d, i) => (
              <div key={d.id}>
                {i > 0 && <Separator />}
                <DeploymentRow
                  deployment={d}
                  appBase={appBase}
                  isCurrent={d.id === liveDeployment?.id}
                  formatStatusLabel={formatHistoricalStatus}
                  showLogs={false}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Dialogs */}
      <Dialog open={showStopConfirm} onOpenChange={(o) => { if (!o) setShowStopConfirm(false) }}>
        <StopAppDialog onConfirm={handleStop} onClose={() => setShowStopConfirm(false)} stopping={stopping} />
      </Dialog>
    </div>
  )
}
