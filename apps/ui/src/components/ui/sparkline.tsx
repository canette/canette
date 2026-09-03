"use client"

import { useId, useMemo, useState } from "react"
import type { AppMetricsSeriesPoint } from "@canette/types"

// buildLinePath turns a series into one or more SVG path "d" segments, split
// wherever the gap between consecutive samples is more than 2x the series'
// typical step — e.g. a Prometheus restart leaving a hole in query_range
// output. Drawing a straight line across a real gap would misrepresent data
// that was never collected, so each contiguous run becomes its own segment.
function buildLinePath(points: AppMetricsSeriesPoint[], width: number, height: number, pad = 2): { segments: string[]; coords: { x: number; y: number; point: AppMetricsSeriesPoint }[] } {
  if (points.length === 0) return { segments: [], coords: [] }

  const minT = points[0].t
  const maxT = points[points.length - 1].t
  const spanT = Math.max(maxT - minT, 1)
  const values = points.map((p) => p.v)
  const rawMinV = Math.min(...values)
  const rawMaxV = Math.max(...values)
  // Floor the y-axis span at 5% of the series' own magnitude (e.g. 33.000MB vs
  // 33.002MB is real-world noise, not a trend — without a floor the axis
  // stretches to fill the chart height and makes it look like a dramatic
  // swing). Expand symmetrically around the data's own midpoint so the actual
  // min/max always stay inside the plotted range.
  const maxAbs = Math.max(Math.abs(rawMinV), Math.abs(rawMaxV))
  const minSpan = Math.max(maxAbs * 0.05, 1e-9)
  const spanV = Math.max(rawMaxV - rawMinV, minSpan)
  const midV = (rawMinV + rawMaxV) / 2
  const minV = midV - spanV / 2

  const innerW = width - pad * 2
  const innerH = height - pad * 2

  const coords = points.map((p) => ({
    x: pad + ((p.t - minT) / spanT) * innerW,
    y: pad + innerH - ((p.v - minV) / spanV) * innerH,
    point: p,
  }))

  const steps = points.slice(1).map((p, i) => p.t - points[i].t).filter((s) => s > 0)
  const typicalStep = steps.length > 0 ? steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)] : Infinity
  const gapThreshold = typicalStep * 2.5

  const segments: string[] = []
  let current = ""
  for (let i = 0; i < coords.length; i++) {
    const prevPoint = i > 0 ? points[i - 1] : null
    const gapped = prevPoint !== null && points[i].t - prevPoint.t > gapThreshold
    if (i === 0 || gapped) {
      if (current) segments.push(current)
      current = `M ${coords[i].x} ${coords[i].y}`
    } else {
      current += ` L ${coords[i].x} ${coords[i].y}`
    }
  }
  if (current) segments.push(current)

  return { segments, coords }
}

interface SparklineProps {
  points: AppMetricsSeriesPoint[]
  width?: number
  height?: number
  className?: string
}

// Sparkline is the compact trend figure — no axes, no hover, meant to ride
// inline next to a StatTile's headline value. A single series needs no
// legend (the tile's label already names it).
export function Sparkline({ points, width = 72, height = 24, className }: SparklineProps) {
  const { segments } = useMemo(() => buildLinePath(points, width, height), [points, width, height])
  if (segments.length === 0) return null

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--info)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
}

interface TimeseriesChartProps {
  points: AppMetricsSeriesPoint[]
  formatValue: (v: number) => string
  height?: number
  className?: string
}

// TimeseriesChart is the larger, in-depth version used on the Metrics tab —
// adds a hover crosshair that snaps to the nearest sample and a tooltip
// showing the exact value/time, per the dataviz skill's interaction spec.
export function TimeseriesChart({ points, formatValue, height = 120, className }: TimeseriesChartProps) {
  const width = 600
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const gradientId = useId()

  const { segments, coords } = useMemo(() => buildLinePath(points, width, height, 8), [points, height])

  if (points.length === 0 || coords.length === 0) {
    // Matches the chart's own height plus the caption row's height (mt-1 + one
    // line of text-xs) so swapping between this state and the real chart never
    // shifts surrounding layout.
    return (
      <div className={className} style={{ height: height + 20 }}>
        <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
          Not enough data yet
        </div>
      </div>
    )
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    let nearest = 0
    let nearestDist = Infinity
    for (let i = 0; i < coords.length; i++) {
      const dist = Math.abs(coords[i].x - px)
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = i
      }
    }
    setHoverIdx(nearest)
  }

  const hover = hoverIdx !== null ? coords[hoverIdx] : null
  // Fall back to the latest point rather than rendering nothing, so this row
  // is always present — otherwise the card grows/shrinks by a line height on
  // every hover in/out, causing a visible layout jump.
  const displayed = hover ?? coords[coords.length - 1]

  return (
    <div className={className}>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-label="Time-series chart"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIdx(null)}
        className="overflow-visible"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity={0.1} />
            <stop offset="100%" stopColor="var(--info)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {segments.map((d, i) => (
          <path key={`area-${i}`} d={`${d} L ${coords[coords.length - 1].x} ${height} L ${coords[0].x} ${height} Z`} fill={`url(#${gradientId})`} stroke="none" />
        ))}
        {segments.map((d, i) => (
          <path key={`line-${i}`} d={d} fill="none" stroke="var(--info)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {hover && (
          <>
            <line x1={hover.x} y1={0} x2={hover.x} y2={height} stroke="var(--border)" strokeWidth={1} />
            <circle cx={hover.x} cy={hover.y} r={4} fill="var(--info)" stroke="var(--card)" strokeWidth={2} />
          </>
        )}
        {/* Transparent full-height hit area so the crosshair tracks the pointer
            anywhere over the chart, not just directly on the line. */}
        <rect x={0} y={0} width={width} height={height} fill="transparent" />
      </svg>
      <div className="flex items-center justify-between text-xs mt-1">
        <span className="text-secondary-foreground font-mono tabular-nums">{formatValue(displayed.point.v)}</span>
        <span className="text-tertiary font-mono">{new Date(displayed.point.t * 1000).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}
