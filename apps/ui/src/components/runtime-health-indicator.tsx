import { Activity, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { RuntimeHealth } from "@canette/types"

// Deliberately separate from StatusBadge/statusVariant: deployments.status
// answers "did the deploy operation succeed" and must never change meaning.
// runtimeHealth answers a different question — "is the current pod actually
// healthy right now" — which can flip long after a successful deploy (e.g. a
// later crash). The two are always rendered as distinct indicators, never
// merged into one badge, so a green "Live" badge next to a red "Crashing"
// chip reads as exactly what it is: the deploy succeeded, but the app is
// currently unhealthy.
export function RuntimeHealthIndicator({
  runtimeHealth,
  runtimeHealthReason,
  className,
}: {
  runtimeHealth: RuntimeHealth
  runtimeHealthReason?: string
  className?: string
}) {
  if (runtimeHealth === "unknown") return null

  if (runtimeHealth === "unhealthy") {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 h-[22px] px-2 rounded-sm text-xs font-medium whitespace-nowrap bg-destructive-soft text-destructive-text",
                className,
              )}
            >
              <AlertTriangle size={12} className="shrink-0" />
              Crashing{runtimeHealthReason ? ` — ${runtimeHealthReason}` : ""}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            The last deploy succeeded, but the running pod is currently unhealthy.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
