import type { getAppNamespace } from "./app-logs"

type AppNamespace = NonNullable<Awaited<ReturnType<typeof getAppNamespace>>>

// fetchFromLogstreamer calls a JSON endpoint on the internal logstreamer
// service for one app. By default pod lookups are scoped to the app's current
// live deployment; pass scopeToLiveDeployment: false to see the newest pod of
// any deployment (e.g. a rollout that is crash-looping and never went live).
// Returns null when the logstreamer is unreachable or responds with a non-2xx
// status — callers decide how to surface that (502 for REST, a tool error
// for MCP).
export async function fetchFromLogstreamer<T>(
  path: string,
  appNs: AppNamespace,
  params: Record<string, string> = {},
  { scopeToLiveDeployment = true }: { scopeToLiveDeployment?: boolean } = {}
): Promise<T | null> {
  const base = process.env.LOGSTREAMER_URL ?? "http://localhost:8080"
  const query = new URLSearchParams({
    project_id: appNs.projectId,
    project_slug: appNs.projectSlug,
    app: appNs.appSlug,
    // Scopes pod lookups to the app's current deployment so a leftover pod
    // from a previous, still-terminating deployment isn't reported as if it
    // belonged to the current one.
    ...(scopeToLiveDeployment && appNs.liveDeploymentId ? { deployment_id: appNs.liveDeploymentId } : {}),
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
