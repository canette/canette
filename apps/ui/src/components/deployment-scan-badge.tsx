import { ShieldAlert, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { Deployment } from "@canette/types"

export function ScanBadge({ deployment }: { deployment: Deployment }) {
  const summary = deployment.scanSummary
  if (!deployment.scanStatus || deployment.scanStatus === "skipped") return null

  if (deployment.scanStatus === "error")
    return <Badge variant="muted" className="gap-1"><ShieldAlert className="h-3 w-3" />Scan error</Badge>

  if (deployment.scanStatus === "fail") {
    const badge = <Badge variant="failed" className="gap-1"><ShieldAlert className="h-3 w-3" />Scan failed</Badge>
    if (!summary) return badge
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild><span>{badge}</span></TooltipTrigger>
          <TooltipContent>
            {summary.critical} critical · {summary.high} high · {summary.medium} medium · {summary.low} low · {summary.unknown} unknown
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return <Badge variant="live" className="gap-1"><ShieldCheck className="h-3 w-3" />Scan clean</Badge>
}
