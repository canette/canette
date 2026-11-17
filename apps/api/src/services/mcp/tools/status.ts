import { db } from "../../../db/db"
import { getAppById, getAppByRef } from "../../apps"
import { getDeploymentById, getLiveDeployment, listDeployments } from "../../deployments"
import { listHostnames } from "../../hostnames"
import { listVolumes } from "../../volumes"
import { getPasswordGateStatus } from "../../password-gate"
import { getAppPodTarget } from "../../app-logs"
import { fetchFromLogstreamer } from "../../logstreamer"
import { arg, argBool, argNum } from "../args"
import { defineTool, err, notFound, ok } from "../tool"
import type { AppMetricsUsage, AppRuntimeLogs } from "@canette/types"

const DEFAULT_LOG_LINES = 100
const MAX_LOG_LINES = 1000

export const statusTools = [
  defineTool({
    name: "get_app",
    description:
      "Get an app's configuration and current state: live URL, custom hostnames, mounted volumes, whether password protection is on, the live deployment (the one serving traffic, null when the app is stopped or has never gone live) and the latest deployment (status and error; it may be a newer rollout that is still in progress or failed). Start here when checking whether an app is up. Identify the app by app_id, or by project_id together with app_slug (e.g. from a URL like /projects/<project>/apps/<app>), not both.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        project_id: { type: "string", description: "Project ID or slug — with app_slug, instead of app_id" },
        app_slug: { type: "string", description: "App slug within the project — with project_id, instead of app_id" },
      },
    },
    handler: async (args, userId) => {
      const app = await resolveApp(args, userId)
      if (!("id" in app)) return app
      const appId = app.id
      const [hostnames, volumes, passwordProtection, liveDeployment, { items }] = await Promise.all([
        listHostnames(db, appId),
        listVolumes(db, appId),
        getPasswordGateStatus(db, appId, userId),
        getLiveDeployment(db, appId),
        listDeployments(db, appId, 1),
      ])
      return ok({
        ...app,
        hostnames: hostnames.map((h) => h.hostname),
        // A summary only: configmap content can be up to 1 MiB, list_volumes has it.
        volumes: volumes.map((v) => ({ id: v.id, name: v.name, type: v.type, mountPath: v.mountPath, size: v.config.size })),
        passwordProtection,
        liveDeployment,
        latestDeployment: items[0] ?? null,
      })
    },
  }),
  defineTool({
    name: "get_runtime_logs",
    description:
      "Get recent logs from the app's running container (not the build). Returns the newest pod's status (phase, ready, restarts, waiting reason such as CrashLoopBackOff, last exit code) plus its last log lines. If the container is crash-looping, logs from the previous crashed instance are returned automatically. Use this when a deployment built fine but the app fails to start or misbehaves. For cronjob apps, returns the most recent run.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        lines: { type: "number", description: `Number of log lines to return (default ${DEFAULT_LOG_LINES}, max ${MAX_LOG_LINES})` },
        previous: { type: "boolean", description: "Force logs from the previous (crashed) container instance" },
        deployment_id: {
          type: "string",
          description: "Only look at pods of this deployment (default: the app's newest pod, whichever deployment it belongs to)",
        },
      },
      required: ["app_id"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      if (!appId) return err("app_id is required")
      const podTarget = await getAppPodTarget(db, appId, userId)
      if (!podTarget) return notFound("App not found or access denied")

      const lines = argNum(args, "lines") ?? DEFAULT_LOG_LINES
      if (!Number.isInteger(lines) || lines < 1) return err("lines must be a positive integer")
      const params: Record<string, string> = { lines: String(Math.min(lines, MAX_LOG_LINES)) }
      if (argBool(args, "previous")) params.previous = "true"

      const deploymentId = arg(args, "deployment_id")
      if (deploymentId) {
        const deployment = await getDeploymentById(db, deploymentId, userId)
        if (!deployment || deployment.appId !== appId) return notFound("Deployment not found for this app")
        params.deployment_id = deploymentId
      }

      // Not scoped to the live deployment: a rollout that crash-loops never
      // becomes live, and its pod is exactly the one worth looking at.
      const result = await fetchFromLogstreamer<AppRuntimeLogs>("/logs/tail", podTarget, params, {
        scopeToLiveDeployment: false,
      })
      if (!result) return err("Could not reach the log service — try again shortly", "UNAVAILABLE")
      if (!result.found) {
        return ok({
          message: "No pods found for this app — it may not be deployed yet, be stopped, or (for cronjobs) not have run yet",
        })
      }
      const { logs, ...status } = result
      return {
        content: [
          { type: "text", text: JSON.stringify(status, null, 2) },
          { type: "text", text: logs || "(no log output)" },
        ],
      }
    },
  }),
  defineTool({
    name: "get_app_metrics",
    description:
      "Get current runtime metrics for the app's live deployment: per-pod ready state, restart count, last termination reason (e.g. OOMKilled) and CPU/memory usage against requests/limits. CPU/memory usage requires metrics-server on the cluster; usageAvailable is false when it is missing.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      if (!appId) return err("app_id is required")
      const podTarget = await getAppPodTarget(db, appId, userId)
      if (!podTarget) return notFound("App not found or access denied")
      const usage = await fetchFromLogstreamer<AppMetricsUsage>("/metrics/usage", podTarget)
      if (!usage) return err("Could not reach the metrics service — try again shortly", "UNAVAILABLE")
      return ok(usage)
    },
  }),
]

// get_app takes either app_id or project_id + app_slug. Returns the app, or an
// error result for a bad combination or an app the user can't see.
async function resolveApp(args: Record<string, unknown>, userId: string) {
  const appId = arg(args, "app_id")
  const projectId = arg(args, "project_id")
  const appSlug = arg(args, "app_slug")
  if (appId && (projectId || appSlug)) return err("Pass either app_id, or project_id and app_slug, not both")
  if (!appId && !projectId && !appSlug) return err("app_id is required (or project_id and app_slug)")
  if (!appId && !(projectId && appSlug)) return err("project_id and app_slug must be passed together")
  const app = appId ? await getAppById(db, appId, userId) : await getAppByRef(db, projectId!, appSlug!, userId)
  return app ?? notFound("App not found or access denied")
}
