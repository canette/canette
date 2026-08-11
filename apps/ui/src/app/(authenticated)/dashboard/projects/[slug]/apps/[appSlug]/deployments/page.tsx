"use client"

import { useEffect, useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Download, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusDot, StatusLabel, formatStatus } from "@/components/ui/status-badge"
import { Terminal } from "@/components/ui/terminal"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import type { BuildLog, Deployment, ScanSummary } from "@canette/types"

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
      }} className="flex-1 overflow-y-auto px-6 pb-6">
        <Terminal className="min-h-full">
          {loading
            ? <span className="flex items-center gap-2 text-[#777b84]"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Loading logs…</span>
            : logs.length === 0
              ? !isTerminal
                ? <span className="flex items-center gap-2 text-[#777b84]"><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />Waiting for logs…</span>
                : <span className="text-[#777b84]">No logs available.</span>
              : <pre className="whitespace-pre-wrap">{logs.map((l) => l.line).join("\n")}</pre>
          }
        </Terminal>
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
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <Terminal className="min-h-full">
          {loading ? <Skeleton className="h-4 w-32" />
            : manifest === null ? <span className="text-[#777b84]">Manifest not available.</span>
              : <pre className="whitespace-pre-wrap">{manifest}</pre>}
        </Terminal>
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
                <div className="flex items-center gap-3.5 px-6 py-3">
                  <StatusDot status={d.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate">
                        {d.commitMessage || shortSha(d.commitSha)}
                      </span>
                      <ScanBadge deployment={d} />
                    </div>
                    <div className="text-[11.5px] text-tertiary font-mono truncate">
                      {shortSha(d.commitSha)} · {timeAgo(d.createdAt)}
                    </div>
                  </div>
                  <StatusLabel status={d.status} label={formatHistoricalStatus(d.status)} className="shrink-0" />
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setLogDeployment(d)}>Logs</Button>
                    {d.status === "live" && (
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setManifestDeployment(d)}>Manifest</Button>
                    )}
                    {d.hasSbom && (d.scanStatus === "pass" || d.scanStatus === "fail") && (
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
