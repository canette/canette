"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusDot, StatusLabel } from "@/components/ui/status-badge"
import { Terminal } from "@/components/ui/terminal"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import { shortSha, timeAgo, formatHistoricalStatus } from "@/lib/deployment-format"
import type { Deployment } from "@canette/types"

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
  const { slug, appSlug } = useParams<{ slug: string; appSlug: string }>()
  const { app } = useAppContext()
  const [deploymentList, setDeploymentList] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [manifestDeployment, setManifestDeployment] = useState<Deployment | null>(null)

  useEffect(() => {
    api.deployments.list(app.id, 50)
      .then((r) => setDeploymentList(r.items))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [app.id])

  const appBase = `/dashboard/projects/${slug}/apps/${appSlug}`

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
                    <Button size="sm" variant="ghost" className="h-7 px-2" asChild>
                      <Link href={`${appBase}/logs?mode=build&deployment=${d.id}`}>Logs</Link>
                    </Button>
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

      <Dialog open={!!manifestDeployment} onOpenChange={(o) => { if (!o) setManifestDeployment(null) }}>
        {manifestDeployment && <ManifestDialog deploymentId={manifestDeployment.id} onClose={() => setManifestDeployment(null)} />}
      </Dialog>
    </div>
  )
}
