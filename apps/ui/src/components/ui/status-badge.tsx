import { cn } from "@/lib/utils"

// Single source of truth for mapping deployment statuses to visual variants.
// pending_build intentionally maps to "pending" — the build hasn't started yet.
export type StatusVariant = "live" | "building" | "deploying" | "failed" | "unhealthy" | "stopped" | "pending"

export function statusVariant(status: string | undefined | null): StatusVariant {
  if (status === "live") return "live"
  if (status === "building" || status === "scanning") return "building"
  if (status === "pending_deployment" || status === "deploying") return "deploying"
  if (status === "failed") return "failed"
  if (status === "unhealthy") return "unhealthy"
  if (status === "stopped") return "stopped"
  return "pending"
}

export function formatStatus(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

const VARIANT_STYLES: Record<StatusVariant, { dot: string; chip: string; text: string; ring: string; pulse?: string }> = {
  live: { dot: "bg-success", chip: "bg-success-soft text-success-text", text: "text-success-text", ring: "ring-[3px] ring-success-soft", pulse: "animate-pulse [animation-duration:1.8s]" },
  building: { dot: "bg-warning", chip: "bg-warning-soft text-warning-text", text: "text-warning-text", ring: "ring-[3px] ring-warning-soft", pulse: "animate-pulse [animation-duration:1s]" },
  deploying: { dot: "bg-info", chip: "bg-info-soft text-info-text", text: "text-info-text", ring: "ring-[3px] ring-info-soft", pulse: "animate-pulse [animation-duration:1.4s]" },
  failed: { dot: "bg-destructive", chip: "bg-destructive-soft text-destructive-text", text: "text-destructive-text", ring: "ring-[3px] ring-destructive-soft" },
  unhealthy: { dot: "bg-destructive", chip: "bg-destructive-soft text-destructive-text", text: "text-destructive-text", ring: "ring-[3px] ring-destructive-soft" },
  stopped: { dot: "bg-tertiary", chip: "bg-muted text-muted-foreground", text: "text-muted-foreground", ring: "ring-[3px] ring-muted" },
  pending: { dot: "bg-tertiary", chip: "bg-muted text-tertiary", text: "text-tertiary", ring: "ring-[3px] ring-muted" },
}

/** Ringed status dot for list rows (the design's deployment-history marker). */
export function StatusDot({ status, className }: { status: string | undefined | null; className?: string }) {
  const s = VARIANT_STYLES[statusVariant(status)]
  return <span className={cn("size-2 rounded-full shrink-0", s.dot, s.ring, s.pulse, className)} />
}

/** Soft chip with a status dot — the design's status pill. */
export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string | undefined | null
  label?: string
  className?: string
}) {
  const v = statusVariant(status)
  const s = VARIANT_STYLES[v]
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 h-[22px] px-2 rounded-sm text-xs font-medium whitespace-nowrap",
      s.chip,
      className,
    )}>
      <span className={cn("size-1.5 rounded-full shrink-0", s.dot, s.pulse)} />
      {label ?? (status ? formatStatus(status) : "Not deployed")}
    </span>
  )
}

/** Bare dot + colored label, for compact rows where a chip is too heavy. */
export function StatusLabel({
  status,
  label,
  className,
}: {
  status: string | undefined | null
  label?: string
  className?: string
}) {
  const v = statusVariant(status)
  const s = VARIANT_STYLES[v]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", s.text, className)}>
      <span className={cn("size-1.5 rounded-full shrink-0", s.dot, s.pulse)} />
      {label ?? (status ? formatStatus(status) : "Not deployed")}
    </span>
  )
}
