import type { AppLifecycleStatus } from "@canette/types"

// The columns lifecycleStatus reads: the app's intent (app_intents), the
// controller's progress on it (app_runtime) and the status of the deployment
// the intent targets. Missing rows read as null.
export interface LifecycleColumns {
  desired_state?: string | null
  intent_generation?: string | number | null
  reconciled_generation?: string | number | null
  target_status?: string | null
  applied_deployment_id?: string | null
}

// lifecycleStatus is the state of an app (#354), the same answer for the UI,
// MCP and the admin pages. It follows the app's intent, not its newest
// deployment, which can be superseded or still on its way. Undefined for an
// app that was never deployed.
export function lifecycleStatus(c: LifecycleColumns): AppLifecycleStatus | undefined {
  const generation = Number(c.intent_generation ?? 0)
  const caughtUp = Number(c.reconciled_generation ?? 0) >= generation
  if (c.desired_state !== "running") {
    if (generation === 0) return undefined
    return caughtUp ? "stopped" : "stopping"
  }
  switch (c.target_status) {
    case "pending_build":
    case "building":
    case "scanning":
      return "building"
    case "pending_deployment":
    case "deploying":
      return "deploying"
    case "live":
      return caughtUp ? "live" : "deploying" // e.g. an admin re-sync
    case "failed":
      return "failed"
    default:
      // The target was replaced or removed, e.g. by a Stop the controller has
      // since recorded. What serves, if anything, says it.
      return c.applied_deployment_id ? "live" : "stopped"
  }
}
