import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { MeterTone, TileMeter } from "@/lib/metrics-format"

interface StatTileProps {
  label: string
  value: string
  caption?: string
  meter?: TileMeter
  // Compact trend figure (see Sparkline in ui/sparkline.tsx), rendered inline
  // next to the headline value when historical data is available.
  sparkline?: ReactNode
  className?: string
}

const meterToneClasses: Record<MeterTone, { track: string; fill: string }> = {
  ok: { track: "bg-success-soft", fill: "bg-success" },
  warning: { track: "bg-warning-soft", fill: "bg-warning" },
  critical: { track: "bg-destructive-soft", fill: "bg-destructive" },
}

export function StatTile({ label, value, caption, meter, sparkline, className }: StatTileProps) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4 flex flex-col gap-1.5", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-2xl font-medium tabular-nums">{value}</span>
        {sparkline}
      </div>
      {meter && (
        <div className={cn("relative h-1.5 rounded-full", meterToneClasses[meter.tone].track)}>
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full", meterToneClasses[meter.tone].fill)}
            style={{ width: `${meter.fillPercent}%` }}
          />
          {meter.markerPercent !== undefined && (
            <div
              className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-foreground/50"
              style={{ left: `${meter.markerPercent}%` }}
            />
          )}
        </div>
      )}
      {caption && <span className="text-xs text-tertiary font-mono">{caption}</span>}
    </div>
  )
}
