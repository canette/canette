export function formatCpu(milli: number): string {
  return milli >= 1000 ? `${(milli / 1000).toFixed(1)} cores` : `${milli}m`
}

export function formatBytes(bytes: number): string {
  const units = ["B", "Ki", "Mi", "Gi", "Ti"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)}${units[unit]}`
}

// sumMetric returns undefined if any input is undefined — used so a tile shows "—"
// rather than a misleading partial total when usage data is incomplete.
export function sumMetric(values: (number | undefined)[]): number | undefined {
  if (values.some((v) => v === undefined)) return undefined
  return (values as number[]).reduce((a, b) => a + b, 0)
}

export function formatPercent(usage: number, limit: number): string {
  return `${Math.round((usage / limit) * 100)}%`
}

// Fraction of the limit at which the meter escalates to critical, regardless of
// where the request marker sits — this is the throttling/OOM danger zone.
const CRITICAL_LIMIT_RATIO = 0.9

export type MeterTone = "ok" | "warning" | "critical"

export interface TileMeter {
  // Fill width as a percentage of the track, clamped to 100 so usage over the
  // limit doesn't overflow the bar — the headline value still shows the real %.
  fillPercent: number
  // Position of the request marker as a percentage of the track (limit = 100%).
  markerPercent?: number
  // "ok" while usage is within its request, "warning" once it exceeds the
  // request, "critical" once it's within CRITICAL_LIMIT_RATIO of the limit.
  tone: MeterTone
}

export interface MetricTile {
  value: string
  caption?: string
  meter?: TileMeter
}

// usageTile derives a stat tile's headline value, caption, and meter bar from a
// live usage number plus its declared request and limit. The percentage of the
// *limit* leads (that's the hard ceiling — throttling/OOM risk), while the meter
// marks where the *request* sits so both reference points read at a glance
// instead of needing two separate tiles.
export function usageTile(
  usage: number | undefined,
  request: number | undefined,
  limit: number | undefined,
  format: (n: number) => string
): MetricTile {
  const knownParts: string[] = []
  if (limit !== undefined) knownParts.push(`${format(limit)} limit`)
  if (request !== undefined) knownParts.push(`${format(request)} request`)

  if (usage === undefined) {
    return { value: "—", caption: knownParts.length ? knownParts.join(" · ") : undefined }
  }
  if (limit === undefined || limit <= 0) {
    return { value: format(usage), caption: request !== undefined ? `${format(request)} request` : undefined }
  }

  const ratio = usage / limit
  const captionParts = [`${format(usage)} of ${format(limit)} limit`]
  if (request !== undefined) captionParts.push(`${format(request)} request`)

  let tone: MeterTone = "ok"
  if (ratio >= CRITICAL_LIMIT_RATIO) tone = "critical"
  else if (request !== undefined && usage > request) tone = "warning"

  return {
    value: formatPercent(usage, limit),
    caption: captionParts.join(" · "),
    meter: {
      fillPercent: Math.min(ratio * 100, 100),
      markerPercent: request !== undefined ? Math.min((request / limit) * 100, 100) : undefined,
      tone,
    },
  }
}
