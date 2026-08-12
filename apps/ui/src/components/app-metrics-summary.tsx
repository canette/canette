"use client"

import { useEffect, useState } from "react"
import { Info } from "lucide-react"
import { StatTile } from "@/components/ui/stat-tile"
import { formatBytes, formatCpu, sumMetric, usageTile } from "@/lib/metrics-format"
import * as api from "@/lib/api"
import type { AppMetricsUsage } from "@canette/types"

// Renders nothing until the app has at least one running/pending pod — there's
// nothing useful to show for a stopped or not-yet-deployed app.
export function AppMetricsSummary({ appId }: { appId: string }) {
  const [usage, setUsage] = useState<AppMetricsUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const u = await api.appMetrics.usage(appId)
        if (!cancelled) setUsage(u)
      } catch {
        if (!cancelled) setUsage(null)
      }
    }
    load()
    const interval = setInterval(load, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [appId])

  if (!usage || usage.pods.length === 0) return null

  const readyCount = usage.pods.filter((p) => p.ready).length
  const restarts = usage.pods.reduce((a, p) => a + p.restarts, 0)
  const cpuUsage = sumMetric(usage.pods.map((p) => p.cpuUsageMilli))
  const cpuRequest = sumMetric(usage.pods.map((p) => p.cpuRequestMilli))
  const cpuLimit = sumMetric(usage.pods.map((p) => p.cpuLimitMilli))
  const memUsage = sumMetric(usage.pods.map((p) => p.memoryUsageBytes))
  const memRequest = sumMetric(usage.pods.map((p) => p.memoryRequestBytes))
  const memLimit = sumMetric(usage.pods.map((p) => p.memoryLimitBytes))
  const cpuTile = usageTile(cpuUsage, cpuRequest, cpuLimit, formatCpu)
  const memTile = usageTile(memUsage, memRequest, memLimit, formatBytes)

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="CPU usage" value={cpuTile.value} caption={cpuTile.caption} meter={cpuTile.meter} />
        <StatTile label="Memory usage" value={memTile.value} caption={memTile.caption} meter={memTile.meter} />
        <StatTile label="Ready pods" value={`${readyCount}/${usage.pods.length}`} />
        <StatTile label="Restarts" value={String(restarts)} />
      </div>
      {!usage.usageAvailable && (
        <div className="flex items-start gap-2 rounded-md bg-warning-soft ring-1 ring-inset ring-warning-line px-3 py-2.5">
          <Info size={14} className="text-warning-text shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">
            Live CPU/memory usage isn&apos;t available on this cluster
            {usage.usageUnavailableReason ? ` (${usage.usageUnavailableReason})` : ""} — pod health is still shown above.
          </p>
        </div>
      )}
    </div>
  )
}
