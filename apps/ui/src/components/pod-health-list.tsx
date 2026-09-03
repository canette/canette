import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AppPodMetrics } from "@canette/types"

// Pod identity + crash detail — the direct "no more kubectl for this" surface:
// per-pod health broken out so a specific unhealthy pod and its exit reason
// are visible without leaving the dashboard.
export function PodHealthList({ pods }: { pods: AppPodMetrics[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
      {pods.map((p) => (
        <div key={p.name} className="flex items-center gap-2 text-xs">
          <span
            className={cn("size-1.5 rounded-full shrink-0", p.ready ? "bg-success" : "bg-destructive")}
            aria-hidden
          />
          <span className="font-mono truncate" title={p.name}>{p.name}</span>
          {!p.ready && p.lastTerminationReason && (
            <span className="flex items-center gap-1 text-destructive-text shrink-0 ml-auto">
              <AlertTriangle size={11} className="shrink-0" />
              {p.lastTerminationReason}
              {p.lastExitCode != null ? ` (exit ${p.lastExitCode})` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
