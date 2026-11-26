import { AlertTriangle, CalendarClock, PauseCircle, Users } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { AppDeploymentType, KubernetesStatus } from "@canette/types"

type Tone = "destructive" | "warning" | "muted"

interface Reading {
  tone: Tone
  icon: ReactNode
  label: string
  explanation: string
}

const TONE_CLASSES: Record<Tone, string> = {
  destructive: "bg-destructive-soft text-destructive-text",
  warning: "bg-warning-soft text-warning-text",
  muted: "bg-muted text-muted-foreground",
}

// Picks the one condition worth showing from what Kubernetes reports, or null
// when there is nothing to flag (full capacity, last run succeeded).
function readStatus(status: KubernetesStatus, deploymentType: AppDeploymentType): Reading | null {
  if (status.workload === "missing") {
    const kind = deploymentType === "cronjob" ? "CronJob" : "Deployment"
    return {
      tone: "destructive",
      icon: <AlertTriangle size={12} className="shrink-0" />,
      label: `${kind} missing`,
      explanation: `The app's ${kind} doesn't exist in Kubernetes, so nothing is running. It may have been deleted outside canette. Redeploy to recreate it.`,
    }
  }

  const replicas = status.replicas
  if (replicas && replicas.available < replicas.desired) {
    return {
      tone: replicas.available === 0 ? "destructive" : "warning",
      icon: <Users size={12} className="shrink-0" />,
      label: `${replicas.available}/${replicas.desired} available`,
      explanation:
        replicas.available === 0
          ? "Kubernetes reports no available replicas, so the app isn't serving traffic."
          : `Kubernetes reports ${replicas.available} of ${replicas.desired} replicas available, so the app is serving at reduced capacity.`,
    }
  }

  const cronJob = status.cronJob
  if (cronJob) {
    if (cronJob.suspended) {
      return {
        tone: "warning",
        icon: <PauseCircle size={12} className="shrink-0" />,
        label: "Suspended",
        explanation: "The CronJob is suspended in Kubernetes, so no new runs start on schedule.",
      }
    }
    if (cronJob.lastJob?.outcome === "failed") {
      return {
        tone: "destructive",
        icon: <AlertTriangle size={12} className="shrink-0" />,
        label: "Last run failed",
        explanation: `The most recent run failed${cronJob.lastJob.reason ? ` (${cronJob.lastJob.reason})` : ""}. Check the run's logs for details.`,
      }
    }
    if (!cronJob.lastJob && !cronJob.lastScheduleTime) {
      return {
        tone: "muted",
        icon: <CalendarClock size={12} className="shrink-0" />,
        label: "Not run yet",
        explanation: "The schedule hasn't triggered a run yet. This is normal for a new or rarely scheduled job.",
      }
    }
  }

  return null
}

// "Kubernetes readiness": what Kubernetes reports for the app's workload
// object (Deployment capacity, CronJob state). Kept separate from
// RuntimeHealthIndicator, which is the verdict on the running pods, so each
// chip answers one question. The API already leaves out a stale reading, so
// kubernetesStatus is used as is.
export function KubernetesReadinessIndicator({
  kubernetesStatus,
  deploymentType,
  className,
}: {
  kubernetesStatus?: KubernetesStatus
  deploymentType: AppDeploymentType
  className?: string
}) {
  if (!kubernetesStatus) return null
  const reading = readStatus(kubernetesStatus, deploymentType)
  if (!reading) return null

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 h-[22px] px-2 rounded-sm text-xs font-medium whitespace-nowrap",
              TONE_CLASSES[reading.tone],
              className,
            )}
          >
            {reading.icon}
            {reading.label}
          </span>
        </TooltipTrigger>
        <TooltipContent>Kubernetes readiness: {reading.explanation}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
