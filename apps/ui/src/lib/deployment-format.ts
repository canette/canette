import { formatStatus } from "@/components/ui/status-badge"

export function shortSha(sha: string) { return sha.slice(0, 7) }

export function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function formatHistoricalStatus(status: string) {
  return status === "live" ? "Deployed" : formatStatus(status)
}

export function formatDuration(startedAt: string, finishedAt: string): string {
  const secs = Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** Mirrors the hostname the controller assigns web apps (apps/controller/internal/k8s/resources.go). */
export function computeAppUrl(appSlug: string, projectSlug: string, domain: string) {
  return `https://${appSlug}-${projectSlug}.${domain}`
}
