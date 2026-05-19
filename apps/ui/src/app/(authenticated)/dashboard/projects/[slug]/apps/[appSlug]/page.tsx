"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Download, ExternalLink, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import type { BuildLog, Deployment, ScanSummary } from "@canette/types"

// ── helpers ───────────────────────────────────────────────────────────────────

type StatusVariant = "live" | "building" | "deploying" | "failed" | "pending" | "secondary"

function statusVariant(status: string | undefined): StatusVariant {
  if (status === "live") return "live"
  if (status === "building" || status === "scanning") return "building"
  if (status === "pending_deployment" || status === "deploying") return "deploying"
  if (status === "failed") return "failed"
  if (status === "stopped") return "secondary"
  return "pending"
}

function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatHistoricalStatus(status: string) {
  return status === "live" ? "Deployed" : formatStatus(status)
}

function shortSha(sha: string) { return sha.slice(0, 7) }

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function parseScanSummary(json: string | undefined): ScanSummary | null {
  if (!json) return null
  try { return JSON.parse(json) } catch { return null }
}

function ScanBadge({ deployment }: { deployment: Deployment }) {
  const summary = parseScanSummary(deployment.scanSummary as string | undefined)
  if (!deployment.scanStatus || deployment.scanStatus === "skipped") return null
  if (deployment.scanStatus === "error")
    return <Badge variant="muted" className="gap-1"><ShieldAlert className="h-3 w-3" />Scan error</Badge>
  if (deployment.scanStatus === "fail") {
    const counts = summary ? `${summary.critical}C ${summary.high}H ${summary.medium}M` : "Failed"
    return <Badge variant="failed" className="gap-1"><ShieldAlert className="h-3 w-3" />{counts}</Badge>
  }
  return <Badge variant="live" className="gap-1"><ShieldCheck className="h-3 w-3" />Clean</Badge>
}

// ── log dialog ────────────────────────────────────────────────────────────────

function LogDialog({ deployment, onClose }: { deployment: Deployment; onClose: () => void }) {
  const [logs, setLogs] = useState<BuildLog[]>([])
  const [loading, setLoading] = useState(true)
  const isTerminal = ["live", "failed", "stopped"].includes(deployment.status)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    let cancelled = false
    async function fetchLogs() {
      try {
        const d = await api.deployments.logs(deployment.id)
        if (!cancelled) setLogs(d.items)
      } catch { /* ignore */ } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchLogs()
    if (isTerminal) return
    const interval = setInterval(fetchLogs, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [deployment.id, isTerminal])

  useEffect(() => {
    if (!userScrolledUp.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    }
  }, [logs])

  function downloadLogs() {
    const text = logs.map((l) => l.line).join("\n")
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `build-${shortSha(deployment.commitSha)}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <DialogContent className="max-h-[80vh] flex flex-col" aria-describedby={undefined}>
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="font-mono text-sm">
          Logs — {shortSha(deployment.commitSha)}
          {deployment.commitMessage && <span className="ml-2 text-muted-foreground font-sans font-normal">{deployment.commitMessage}</span>}
        </DialogTitle>
        <div className="flex items-center gap-1">
          {isTerminal && !loading && logs.length > 0 && (
            <Button variant="ghost" size="icon" onClick={downloadLogs} className="h-7 w-7" title="Download logs">
              <Download size={14} />
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7"><X size={14} /></Button>
          </DialogClose>
        </div>
      </DialogHeader>
      <div ref={scrollRef} onScroll={() => {
        const el = scrollRef.current
        if (el) userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 48
      }} className="flex-1 overflow-y-auto p-6 pt-0">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Loading logs…</div>
        ) : logs.length === 0 ? (
          !isTerminal
            ? <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Waiting for logs…</div>
            : <p className="text-muted-foreground text-sm">No logs available.</p>
        ) : (
          <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">{logs.map((l) => l.line).join("\n")}</pre>
        )}
      </div>
    </DialogContent>
  )
}

// ── runtime log dialog ────────────────────────────────────────────────────────

type CronRunMeta = { status: "succeeded" | "failed" | "no_runs"; startedAt?: string; finishedAt?: string }

function formatDuration(startedAt: string, finishedAt: string): string {
  const secs = Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function RuntimeLogDialog({ appId, isCronJob, onClose }: { appId: string; isCronJob: boolean; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [cronMeta, setCronMeta] = useState<CronRunMeta | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)

  useEffect(() => {
    const source = api.appLogs.stream(appId)
    source.onopen = () => setConnected(true)
    source.addEventListener("log", (e) => {
      setLines((prev) => { const next = [...prev, (e as MessageEvent).data]; return next.length > 500 ? next.slice(-500) : next })
    })
    source.addEventListener("meta", (e) => {
      try { setCronMeta(JSON.parse((e as MessageEvent).data)) } catch { /* ignore */ }
    })
    source.onerror = () => { setConnected(false); source.close() }
    source.addEventListener("ping", () => {})
    return () => source.close()
  }, [appId])

  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines])

  return (
    <DialogContent className="max-h-[80vh] flex flex-col max-w-3xl" aria-describedby={undefined}>
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="text-sm">{isCronJob ? "Last run logs" : "App logs"}</DialogTitle>
        <DialogClose asChild>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7"><X size={14} /></Button>
        </DialogClose>
      </DialogHeader>
      {cronMeta && cronMeta.status !== "no_runs" && (
        <div className="mx-6 mb-2 flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className={cronMeta.status === "succeeded" ? "text-green-500 font-medium" : "text-destructive font-medium"}>
            {cronMeta.status === "succeeded" ? "Succeeded" : "Failed"}
          </span>
          {cronMeta.startedAt && <span>{new Date(cronMeta.startedAt).toLocaleString()}</span>}
          {cronMeta.startedAt && cronMeta.finishedAt && (
            <span>{formatDuration(cronMeta.startedAt, cronMeta.finishedAt)}</span>
          )}
        </div>
      )}
      <div ref={scrollRef} onScroll={() => {
        const el = scrollRef.current
        if (el) userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 48
      }} className="flex-1 overflow-y-auto p-6 pt-0">
        {cronMeta?.status === "no_runs"
          ? <p className="text-muted-foreground text-sm">No runs yet.</p>
          : (!connected && !cronMeta)
            ? <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />{isCronJob ? "Fetching last run…" : "Connecting…"}</div>
            : lines.length === 0
              ? <p className="text-muted-foreground text-sm">{isCronJob ? "No output." : "No logs yet. They will appear here once the app starts generating output."}</p>
              : <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">{lines.join("\n")}</pre>
        }
      </div>
    </DialogContent>
  )
}

// ── manifest dialog ───────────────────────────────────────────────────────────

function ManifestDialog({ deploymentId, onClose }: { deploymentId: string; onClose: () => void }) {
  const [manifest, setManifest] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.deployments.manifest(deploymentId).then((r) => setManifest(r.manifest)).catch(() => setManifest(null)).finally(() => setLoading(false))
  }, [deploymentId])

  return (
    <DialogContent className="max-h-[80vh] flex flex-col max-w-3xl" aria-describedby={undefined}>
      <DialogHeader className="flex-row items-center justify-between">
        <DialogTitle className="text-sm">Applied manifest</DialogTitle>
        <DialogClose asChild>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7"><X size={14} /></Button>
        </DialogClose>
      </DialogHeader>
      <div className="flex-1 overflow-y-auto p-6 pt-0">
        {loading ? <Skeleton className="h-4 w-32" />
          : manifest === null ? <p className="text-muted-foreground text-sm">Manifest not available.</p>
            : <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">{manifest}</pre>}
      </div>
    </DialogContent>
  )
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

  const [logDeployment, setLogDeployment] = useState<Deployment | null>(null)
  const [showRuntimeLogs, setShowRuntimeLogs] = useState(false)
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

  return (
    <div className="flex flex-col gap-6">
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
                <CardDescription>Never deployed</CardDescription>
              )}
            </div>
            <Badge variant={currentDeployment ? statusVariant(currentDeployment.status) : "pending"}>
              {currentDeployment ? formatStatus(currentDeployment.status) : "Not deployed"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {actionError && <p className="text-sm text-destructive">{actionError}</p>}
          {currentDeployment?.status === "failed" && currentDeployment.errorMessage && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <p className="text-xs font-medium text-destructive mb-1">Build failed</p>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{currentDeployment.errorMessage}</p>
            </div>
          )}
          {liveDeployment && app.liveUrl && (
            <a href={app.liveUrl} target="_blank" rel="noopener noreferrer"
              className="group flex items-center gap-2 w-fit rounded-md border border-border px-3 py-1.5 text-sm font-mono hover:border-foreground/30 transition-colors">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              {app.liveUrl}
              <ExternalLink size={12} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
            </a>
          )}
          {liveDeployment && app.deploymentType === "private" && (
            <div className="flex items-center gap-2 w-fit rounded-md border border-border px-3 py-1.5 text-sm font-mono text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
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
              <Badge variant={statusVariant(latestDeployment.status)}>{formatHistoricalStatus(latestDeployment.status)}</Badge>
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
              <Button size="sm" variant="ghost" onClick={() => setLogDeployment(latestDeployment)}>Deploy logs</Button>
            )}
            {currentDeployment?.status === "live" && (
              <Button size="sm" variant="ghost" onClick={() => setShowRuntimeLogs(true)}>
                {app.deploymentType === "cronjob" ? "Last run logs" : "App logs"}
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
                <div className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant={statusVariant(d.status)} className="shrink-0">{formatHistoricalStatus(d.status)}</Badge>
                    <span className="font-mono text-xs text-muted-foreground shrink-0">{shortSha(d.commitSha)}</span>
                    {d.commitMessage && (
                      <span className="text-sm text-foreground/80 truncate">{d.commitMessage}</span>
                    )}
                    <ScanBadge deployment={d} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <span className="text-xs text-muted-foreground">{timeAgo(d.createdAt)}</span>
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setLogDeployment(d)}>Logs</Button>
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

      <Dialog open={!!logDeployment} onOpenChange={(o) => { if (!o) setLogDeployment(null) }}>
        {logDeployment && <LogDialog deployment={logDeployment} onClose={() => setLogDeployment(null)} />}
      </Dialog>

      <Dialog open={showRuntimeLogs} onOpenChange={(o) => { if (!o) setShowRuntimeLogs(false) }}>
        {showRuntimeLogs && <RuntimeLogDialog appId={app.id} isCronJob={app.deploymentType === "cronjob"} onClose={() => setShowRuntimeLogs(false)} />}
      </Dialog>

      <Dialog open={!!manifestDeployment} onOpenChange={(o) => { if (!o) setManifestDeployment(null) }}>
        {manifestDeployment && <ManifestDialog deploymentId={manifestDeployment.id} onClose={() => setManifestDeployment(null)} />}
      </Dialog>
    </div>
  )
}
