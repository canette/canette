"use client"

import { useEffect, useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Download, Loader2, X } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import type { BuildLog, Deployment, ScanSummary } from "@canette/types"

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
  if (deployment.scanStatus === "error") return <span className="text-xs text-muted-foreground">Scan error</span>
  const counts = summary ? `${summary.critical}C ${summary.high}H ${summary.medium}M` : ""
  const color = deployment.scanStatus === "fail" ? "text-red-600" : "text-green-600"
  return <span className={`text-xs ${color} shrink-0`}>Scan: {counts || (deployment.scanStatus === "pass" ? "clean" : "failed")}</span>
}

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
      requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight })
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
            <Button variant="ghost" size="icon" onClick={downloadLogs} className="h-7 w-7"><Download size={14} /></Button>
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
        {loading
          ? <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Loading logs…</div>
          : logs.length === 0
            ? !isTerminal
              ? <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Waiting for logs…</div>
              : <p className="text-muted-foreground text-sm">No logs available.</p>
            : <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap leading-5">{logs.map((l) => l.line).join("\n")}</pre>
        }
      </div>
    </DialogContent>
  )
}

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

export default function DeploymentsPage() {
  const { app } = useAppContext()
  const [deploymentList, setDeploymentList] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [logDeployment, setLogDeployment] = useState<Deployment | null>(null)
  const [manifestDeployment, setManifestDeployment] = useState<Deployment | null>(null)

  useEffect(() => {
    api.deployments.list(app.id, 50)
      .then((r) => setDeploymentList(r.items))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [app.id])

  return (
    <div className="flex flex-col gap-6">
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
                <div className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant={statusVariant(d.status)} className="shrink-0">{formatStatus(d.status)}</Badge>
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
                    {(d.scanStatus === "pass" || d.scanStatus === "fail") && (
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={async () => {
                        try {
                          const { sbom } = await api.deployments.sbom(d.id)
                          const blob = new Blob([sbom], { type: "application/json" })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement("a")
                          a.href = url
                          a.download = `sbom-${shortSha(d.commitSha)}.json`
                          a.click()
                          URL.revokeObjectURL(url)
                        } catch { /* no sbom */ }
                      }}>SBOM</Button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={!!logDeployment} onOpenChange={(o) => { if (!o) setLogDeployment(null) }}>
        {logDeployment && <LogDialog deployment={logDeployment} onClose={() => setLogDeployment(null)} />}
      </Dialog>

      <Dialog open={!!manifestDeployment} onOpenChange={(o) => { if (!o) setManifestDeployment(null) }}>
        {manifestDeployment && <ManifestDialog deploymentId={manifestDeployment.id} onClose={() => setManifestDeployment(null)} />}
      </Dialog>
    </div>
  )
}
