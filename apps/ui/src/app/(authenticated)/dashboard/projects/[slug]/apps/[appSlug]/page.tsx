"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { ExternalLink, Info, ShieldAlert, ShieldCheck } from "lucide-react"
import { StatusBadge, StatusDot, StatusLabel, formatStatus } from "@/components/ui/status-badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ManifestDialog } from "@/components/manifest-dialog"
import { AppMetricsSummary } from "@/components/app-metrics-summary"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import { shortSha, timeAgo, formatHistoricalStatus } from "@/lib/deployment-format"
import type { Deployment } from "@canette/types"

// ── helpers ───────────────────────────────────────────────────────────────────

function ScanBadge({ deployment }: { deployment: Deployment }) {
  const summary = deployment.scanSummary
  if (!deployment.scanStatus || deployment.scanStatus === "skipped") return null

  if (deployment.scanStatus === "error")
    return <Badge variant="muted" className="gap-1"><ShieldAlert className="h-3 w-3" />Scan error</Badge>

  if (deployment.scanStatus === "fail") {
    const badge = <Badge variant="failed" className="gap-1"><ShieldAlert className="h-3 w-3" />Scan failed</Badge>
    if (!summary) return badge
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild><span>{badge}</span></TooltipTrigger>
          <TooltipContent>
            {summary.critical} critical · {summary.high} high · {summary.medium} medium · {summary.low} low · {summary.unknown} unknown
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return <Badge variant="live" className="gap-1"><ShieldCheck className="h-3 w-3" />Scan clean</Badge>
}

// ── stop confirm dialog ───────────────────────────────────────────────────────

function StopDialog({ onConfirm, onClose, stopping }: { onConfirm: () => void; onClose: () => void; stopping: boolean }) {
  const [confirmed, setConfirmed] = useState(false)
  return (
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>Stop app?</DialogTitle></DialogHeader>
      <div className="px-6 pb-6 flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">This will terminate the running deployment. The app will be unavailable until you redeploy.</p>
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(!!v)} />
          <span className="text-sm">Yes, stop this app</span>
        </label>
        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={!confirmed || stopping} onClick={onConfirm}>
            {stopping ? "Stopping…" : "Stop app"}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

// ── overview page ─────────────────────────────────────────────────────────────

export default function AppOverviewPage() {
  const { slug: projectSlug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const { app, project, refresh } = useAppContext()

  const [deploymentList, setDeploymentList] = useState<Deployment[]>([])
  const [loadingDeps, setLoadingDeps] = useState(true)

  const [deploying, setDeploying] = useState(false)
  const [redeploying, setRedeploying] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState("")
  const [showStopConfirm, setShowStopConfirm] = useState(false)

  const [manifestDeployment, setManifestDeployment] = useState<Deployment | null>(null)

  const loadDeployments = useCallback(async () => {
    try {
      const data = await api.deployments.list(app.id)
      setDeploymentList(data.items)
    } catch { /* ignore */ } finally {
      setLoadingDeps(false)
    }
  }, [app.id])

  useEffect(() => { loadDeployments() }, [loadDeployments])

  const hasActiveDeployment = deploymentList.some(
    (d) => ["pending_build", "building", "scanning", "pending_deployment", "deploying"].includes(d.status)
  )
  const liveDeployment = deploymentList.find((d) => d.status === "live")
  const latestDeployment = deploymentList[0]
  const currentDeployment = liveDeployment ?? latestDeployment
  const showLatestBuildRow = !!(liveDeployment && latestDeployment && latestDeployment.id !== liveDeployment.id)
  const canRedeploy = !!(
    currentDeployment?.imageDigest &&
    !hasActiveDeployment &&
    ["live", "failed", "stopped"].includes(currentDeployment.status)
  )

  // Auto-refresh while active
  useEffect(() => {
    if (!hasActiveDeployment) return
    const interval = setInterval(() => { loadDeployments(); refresh() }, 3000)
    return () => clearInterval(interval)
  }, [hasActiveDeployment, loadDeployments, refresh])

  async function handleDeploy() {
    setActionError("")
    setDeploying(true)
    try {
      await api.deployments.trigger(app.id)
      await Promise.all([loadDeployments(), refresh()])
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Deploy failed")
    } finally { setDeploying(false) }
  }

  async function handleRedeploy(deploymentId: string) {
    setActionError("")
    setRedeploying(true)
    try {
      await api.deployments.redeploy(deploymentId)
      await Promise.all([loadDeployments(), refresh()])
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Redeploy failed")
    } finally { setRedeploying(false) }
  }

  async function handleStop() {
    setActionError("")
    setStopping(true)
    try {
      await api.apps.stop(app.id)
      setShowStopConfirm(false)
      await Promise.all([loadDeployments(), refresh()])
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Stop failed")
    } finally { setStopping(false) }
  }

  const recentDeployments = deploymentList
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
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base">Status</CardTitle>
              {currentDeployment ? (
                <CardDescription>
                  <span className="font-mono">{shortSha(currentDeployment.commitSha)}</span>
                  {currentDeployment.commitMessage && ` — ${currentDeployment.commitMessage}`}
                  <span className="ml-2 text-xs">{timeAgo(currentDeployment.createdAt)}</span>
                </CardDescription>
              ) : (
                <CardDescription>Not deployed yet</CardDescription>
              )}
            </div>
            <StatusBadge status={currentDeployment?.status} label={currentDeployment ? formatStatus(currentDeployment.status) : "Not deployed"} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
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
          {liveDeployment && app.liveUrl && app.deploymentType !== "private" && (
            <a href={app.liveUrl} target="_blank" rel="noopener noreferrer"
              className="group flex items-center gap-2 w-fit rounded-md border border-border px-3 py-1.5 text-sm font-mono hover:border-foreground/30 transition-colors">
              <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
              {app.liveUrl}
              <ExternalLink size={12} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
            </a>
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
            {canRedeploy ? (
              <>
                <Button size="sm" onClick={() => handleRedeploy(currentDeployment!.id)} disabled={redeploying}>
                  {redeploying ? "Redeploying…" : "Redeploy"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleDeploy} disabled={deploying}>
                  {app.sourceType === "git" ? "Rebuild" : "Deploy new"}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={handleDeploy} disabled={deploying || hasActiveDeployment}>
                {deploying ? "Deploying…" : hasActiveDeployment ? "In progress…" : "Deploy"}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setShowStopConfirm(true)}
              disabled={stopping || !currentDeployment || !["live", "failed"].includes(currentDeployment.status)}>
              Stop
            </Button>
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
        </CardContent>
      </Card>

      {/* Recent deployments */}
      {!loadingDeps && recentDeployments.length > 0 && (
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
            {recentDeployments.map((d, i) => (
              <div key={d.id}>
                {i > 0 && <Separator />}
                <div className="flex items-center gap-3.5 px-6 py-3">
                  <StatusDot status={d.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate">
                        {d.commitMessage || shortSha(d.commitSha)}
                      </span>
                      {d.id === liveDeployment?.id && (
                        <span className="text-[10.5px] font-medium text-success-text bg-success-soft px-1.5 py-px rounded-sm shrink-0">Current</span>
                      )}
                      <ScanBadge deployment={d} />
                    </div>
                    <div className="text-[11.5px] text-tertiary font-mono truncate">
                      {shortSha(d.commitSha)} · {timeAgo(d.createdAt)}
                    </div>
                  </div>
                  <StatusLabel status={d.status} label={formatHistoricalStatus(d.status)} className="shrink-0" />
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 px-2" asChild>
                      <Link href={`${appBase}/logs?mode=build&deployment=${d.id}`}>Logs</Link>
                    </Button>
                    {d.status === "live" && (
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setManifestDeployment(d)}>Manifest</Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Dialogs */}
      <Dialog open={showStopConfirm} onOpenChange={(o) => { if (!o) setShowStopConfirm(false) }}>
        <StopDialog onConfirm={handleStop} onClose={() => setShowStopConfirm(false)} stopping={stopping} />
      </Dialog>

      <Dialog open={!!manifestDeployment} onOpenChange={(o) => { if (!o) setManifestDeployment(null) }}>
        {manifestDeployment && <ManifestDialog deploymentId={manifestDeployment.id} onClose={() => setManifestDeployment(null)} />}
      </Dialog>
    </div>
  )
}
