"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { StatusDot, StatusLabel } from "@/components/ui/status-badge"
import { ScanBadge } from "@/components/deployment-scan-badge"
import { shortSha, timeAgo } from "@/lib/deployment-format"
import * as api from "@/lib/api"
import type { Deployment } from "@canette/types"

type DeploymentRowProps = {
  deployment: Deployment
  appBase: string
  isCurrent: boolean
  formatStatusLabel: (status: string) => string
  showLogs?: boolean
  onManifest?: (deployment: Deployment) => void
  showSbom?: boolean
  onRedeploy?: (deploymentId: string) => void
  canRedeploy?: boolean
  redeploying?: boolean
}

export function DeploymentRow({
  deployment: d,
  appBase,
  isCurrent,
  formatStatusLabel,
  showLogs = true,
  onManifest,
  showSbom = false,
  onRedeploy,
  canRedeploy = false,
  redeploying = false,
}: DeploymentRowProps) {
  const hasActions = showLogs || (d.status === "live" && !!onManifest) || (showSbom && d.hasSbom) || (!!onRedeploy && canRedeploy && !isCurrent)
  return (
    <div className="flex items-center gap-3.5 px-6 py-3">
      <StatusDot status={d.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-[13px] font-medium truncate min-w-0 max-w-[45vw] sm:max-w-[320px] md:max-w-[420px]"
            title={d.commitMessage || undefined}
          >
            {d.commitMessage || shortSha(d.commitSha)}
          </span>
          {isCurrent && (
            <span className="text-[10.5px] font-medium text-success-text bg-success-soft px-1.5 py-px rounded-sm shrink-0">Current</span>
          )}
          <ScanBadge deployment={d} />
        </div>
        <div className="text-[11.5px] text-tertiary font-mono truncate">
          {shortSha(d.commitSha)} · {timeAgo(d.createdAt)}
        </div>
      </div>
      <StatusLabel status={d.status} label={formatStatusLabel(d.status)} className="shrink-0" />
      {hasActions && (
        <div className="flex items-center gap-1 shrink-0">
          {onRedeploy && canRedeploy && !isCurrent && (
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={redeploying} onClick={() => onRedeploy(d.id)}>
              {redeploying ? "Redeploying…" : "Redeploy"}
            </Button>
          )}
          {showLogs && (
            <Button size="sm" variant="ghost" className="h-7 px-2" asChild>
              <Link href={`${appBase}/logs?mode=build&deployment=${d.id}`}>Logs</Link>
            </Button>
          )}
          {d.status === "live" && onManifest && (
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onManifest(d)}>Manifest</Button>
          )}
          {showSbom && d.hasSbom && (d.scanStatus === "pass" || d.scanStatus === "fail") && (
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
      )}
    </div>
  )
}
