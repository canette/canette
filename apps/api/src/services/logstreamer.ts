import type { AppPodTarget } from "./app-logs"

// fetchFromLogstreamer calls a JSON endpoint on the internal logstreamer
// service for one app. By default pod lookups are scoped to the app's current
// live deployment; pass scopeToLiveDeployment: false to see the newest pod of
// any deployment (e.g. a rollout that is crash-looping and never went live).
// Returns null when the logstreamer is unreachable or responds with a non-2xx
// status — callers decide how to surface that (502 for REST, a tool error
// for MCP).
export async function fetchFromLogstreamer<T>(
  path: string,
  target: AppPodTarget,
  params: Record<string, string> = {},
  { scopeToLiveDeployment = true }: { scopeToLiveDeployment?: boolean } = {}
): Promise<T | null> {
  const base = process.env.LOGSTREAMER_URL ?? "http://localhost:8080"
  const query = new URLSearchParams({
    project_id: target.projectId,
    project_slug: target.projectSlug,
    app: target.appSlug,
    // Scopes pod lookups to the app's current deployment so a leftover pod
    // from a previous, still-terminating deployment isn't reported as if it
    // belonged to the current one.
    ...(scopeToLiveDeployment && target.liveDeploymentId ? { deployment_id: target.liveDeploymentId } : {}),
    ...params,
  })

  const secret = process.env.LOGSTREAMER_SECRET ?? ""
  try {
    const upstream = await fetch(`${base}${path}?${query}`, {
      headers: { Authorization: `Bearer ${secret}` },
    })
    if (!upstream.ok) return null
    return (await upstream.json()) as T
  } catch {
    return null
  }
}
