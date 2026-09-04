import { Activity, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { HelpTooltip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { RuntimeHealth } from "@canette/types"

// Plain-language explanations for apps/controller/internal/health/verdict.go's
// evaluatePod reasons — keep in sync if a new reason is added there.
const REASON_EXPLANATIONS: Record<string, string> = {
  "CrashLoopBackOff":
    "The app keeps crashing right after it starts, so Kubernetes is repeatedly restarting it with a growing delay between attempts.",
  "ImagePullBackOff":
    "Kubernetes couldn't download the container image and is waiting before trying again.",
  "ErrImagePull":
    "Kubernetes couldn't download the container image — it may not exist, or access may be denied.",
  "restarting repeatedly":
    "The app has restarted several times in the last few minutes, which usually means it's failing shortly after startup.",
  "readiness probe failing":
    "The app is running, but it isn't passing the health checks it needs to pass before it can receive traffic.",
  "no running pods": "There's no running instance of this app right now.",
}

// How long the watcher's verdict is trusted without a fresh update before
// being treated as stale. The watcher (apps/controller/internal/health/watcher.go)
// re-evaluates on every pod event plus a resyncPeriod (5 min) safety-net
// replay, so a verdict that hasn't moved in twice that long means the
// watcher itself has stopped updating it (informer hiccup, pod restart,
// etc.) — the stored value, including a lingering "unhealthy", can no
// longer be trusted and is treated as unknown instead.
const STALE_AFTER_MS = 10 * 60 * 1000

export function isRuntimeHealthStale(runtimeHealthUpdatedAt?: string): boolean {
  if (!runtimeHealthUpdatedAt) return false
  return Date.now() - new Date(runtimeHealthUpdatedAt).getTime() > STALE_AFTER_MS
}

/** The runtime health to actually use for display/logic — a stale verdict reads as unknown. */
export function effectiveRuntimeHealth(
  runtimeHealth: RuntimeHealth,
  runtimeHealthUpdatedAt?: string,
): RuntimeHealth {
  return isRuntimeHealthStale(runtimeHealthUpdatedAt) ? "unknown" : runtimeHealth
}

function getReasonExplanation(reason: string): string | undefined {
  if (REASON_EXPLANATIONS[reason]) return REASON_EXPLANATIONS[reason]
  const exitMatch = reason.match(/^(.+) \(exit (\d+)\)$/)
  if (exitMatch) {
    const [, terminationReason, code] = exitMatch
    if (terminationReason === "OOMKilled") {
      return `The app's process was killed for using too much memory (exit code ${code}).`
    }
    return `The app's process exited unexpectedly with exit code ${code}.`
  }
  return undefined
}

// Deliberately separate from StatusBadge/statusVariant: deployments.status
// answers "did the deploy operation succeed" and must never change meaning.
// runtimeHealth answers a different question — "is the current pod actually
// healthy right now" — which can flip long after a successful deploy (e.g. a
// later crash). The two are always rendered as distinct indicators, never
// merged into one badge, so a green "Live" badge next to a red "Unhealthy"
// chip reads as exactly what it is: the deploy succeeded, but the app is
// currently unhealthy.
export function RuntimeHealthIndicator({
  runtimeHealth: rawRuntimeHealth,
  runtimeHealthReason,
  runtimeHealthUpdatedAt,
  className,
}: {
  runtimeHealth: RuntimeHealth
  runtimeHealthReason?: string
  runtimeHealthUpdatedAt?: string
  className?: string
}) {
  const runtimeHealth = effectiveRuntimeHealth(rawRuntimeHealth, runtimeHealthUpdatedAt)
  if (runtimeHealth === "unknown") return null

  if (runtimeHealth === "unhealthy") {
    const explanation = runtimeHealthReason ? getReasonExplanation(runtimeHealthReason) : undefined
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 h-[22px] px-2 rounded-sm text-xs font-medium whitespace-nowrap bg-destructive-soft text-destructive-text",
          className,
        )}
      >
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle size={12} className="shrink-0" />
                Unhealthy{runtimeHealthReason ? ` — ${runtimeHealthReason}` : ""}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              The last deploy succeeded, but the running pod is currently unhealthy.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {explanation && <HelpTooltip>{explanation}</HelpTooltip>}
      </span>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center text-muted-foreground", className)}>
            <Activity size={13} />
          </span>
        </TooltipTrigger>
        <TooltipContent>Healthy — the running pod is passing its health checks.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
