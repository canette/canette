"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Info } from "lucide-react"
import { StatTile } from "@/components/ui/stat-tile"
import { Skeleton } from "@/components/ui/skeleton"
import { TimeseriesChart } from "@/components/ui/sparkline"
import { PodHealthList } from "@/components/pod-health-list"
import { formatBytes, formatCpu, sumMetric, usageTile } from "@/lib/metrics-format"
import { useAppContext } from "@/lib/app-context"
import * as api from "@/lib/api"
import type { AppMetricsTimeseries, AppMetricsUsage } from "@canette/types"

// A titled card wrapper for one group of metrics — kept as a distinct section
// (rather than one flat page) so a future metric family (e.g. Traefik traffic,
// #168 Step 3) can be appended as a sibling section without restructuring.
function MetricsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </div>
  )
}

// Placeholder mirroring the loaded layout (two stat tiles + pod list) so the
// tab doesn't flash the "no running pods" empty state before the first fetch.
function MetricsSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <MetricsSection title="Resource usage">
        <div className="grid grid-cols-2 gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-1.5 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
      </MetricsSection>
      <MetricsSection title="Pod health">
        <div className="rounded-md border border-border px-3 py-2">
          <Skeleton className="h-4 w-48" />
        </div>
      </MetricsSection>
    </div>
  )
}

export default function MetricsPage() {
  const { app } = useAppContext()
  const [usage, setUsage] = useState<AppMetricsUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [timeseries, setTimeseries] = useState<AppMetricsTimeseries | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const u = await api.appMetrics.usage(app.id)
        if (!cancelled) setUsage(u)
      } catch {
        if (!cancelled) setUsage(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [app.id])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const t = await api.appMetrics.timeseries(app.id)
        if (!cancelled) setTimeseries(t)
      } catch {
        if (!cancelled) setTimeseries(null)
      }
    }
    load()
    const interval = setInterval(load, 15000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [app.id])

  if (loading) return <MetricsSkeleton />

  if (!usage || usage.pods.length === 0) {
    return <p className="text-sm text-muted-foreground">No running pods to report metrics for.</p>
  }

  const cpuUsage = sumMetric(usage.pods.map((p) => p.cpuUsageMilli))
  const cpuRequest = sumMetric(usage.pods.map((p) => p.cpuRequestMilli))
  const cpuLimit = sumMetric(usage.pods.map((p) => p.cpuLimitMilli))
  const memUsage = sumMetric(usage.pods.map((p) => p.memoryUsageBytes))
  const memRequest = sumMetric(usage.pods.map((p) => p.memoryRequestBytes))
  const memLimit = sumMetric(usage.pods.map((p) => p.memoryLimitBytes))
  const cpuTile = usageTile(cpuUsage, cpuRequest, cpuLimit, formatCpu)
  const memTile = usageTile(memUsage, memRequest, memLimit, formatBytes)

  const hasHistory = timeseries?.available === true

  return (
    <div className="flex flex-col gap-8">
      <MetricsSection title="Resource usage">
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="CPU usage" value={cpuTile.value} caption={cpuTile.caption} meter={cpuTile.meter} />
          <StatTile label="Memory usage" value={memTile.value} caption={memTile.caption} meter={memTile.meter} />
        </div>
        {hasHistory ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <span className="text-xs text-muted-foreground">CPU over time</span>
              <TimeseriesChart points={timeseries.cpuMilli ?? []} formatValue={formatCpu} className="mt-2" />
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <span className="text-xs text-muted-foreground">Memory over time</span>
              <TimeseriesChart points={timeseries.memoryBytes ?? []} formatValue={formatBytes} className="mt-2" />
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2.5">
            <Info size={14} className="text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              Historical CPU/memory charts require Prometheus to be configured on this cluster — instant usage is still shown above.
            </p>
          </div>
        )}
      </MetricsSection>
      <MetricsSection title="Pod health">
        <PodHealthList pods={usage.pods} />
      </MetricsSection>
    </div>
  )
}
