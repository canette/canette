import { db } from "../../../db/db"
import { getAppById } from "../../apps"
import {
  createDeployment,
  listDeployments,
  getDeploymentLogTail,
  getDeploymentById,
  getLiveDeployment,
  redeployDeployment,
  stopApp,
} from "../../deployments"
import { arg, argInt } from "../args"
import { defineTool, err, notFound, ok } from "../tool"
import type { BuildLog } from "@canette/types"

const DEFAULT_BUILD_LOG_LINES = 200
const MAX_BUILD_LOG_LINES = 2000
const DEFAULT_DEPLOYMENTS = 10
const MAX_DEPLOYMENTS = 100

export const deploymentTools = [
  defineTool({
    name: "trigger_deployment",
    description:
      "Build and deploy an app from its source: for a Git app this fetches the latest commit and runs a full image build (minutes) before deploying; for a Docker image app it deploys the configured image tag. Use this for the first deployment and whenever the source changed (new commits, branch, repository, image tag). Do NOT use it just to apply changed env vars, secrets or runtime settings — use redeploy_deployment for that, which reuses the existing image and skips the build.",
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
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      const deployment = await createDeployment(db, appId, userId)
      return ok(deployment)
    },
  }),
  defineTool({
    name: "list_deployments",
    description: `List an app's most recent deployments, newest first (${DEFAULT_DEPLOYMENTS} by default). Use this to find a deployment_id when troubleshooting a failed deployment that was not triggered by this session, or an earlier live deployment to roll back to.`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        limit: { type: "number", description: `How many deployments to return (default ${DEFAULT_DEPLOYMENTS}, max ${MAX_DEPLOYMENTS})` },
      },
      required: ["app_id"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      if (!appId) return err("app_id is required")
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      const limit = argInt(args, "limit") ?? DEFAULT_DEPLOYMENTS
      if (!(limit >= 1)) return err("limit must be a positive integer")
      const { items } = await listDeployments(db, appId, Math.min(limit, MAX_DEPLOYMENTS))
      return ok(items)
    },
  }),
  defineTool({
    name: "get_deployment",
    description: "Get deployment details including status and error information.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Deployment ID" },
      },
      required: ["deployment_id"],
    },
    handler: async (args, userId) => {
      const deploymentId = arg(args, "deployment_id")
      if (!deploymentId) return err("deployment_id is required")
      const deployment = await getDeploymentById(db, deploymentId, userId)
      if (!deployment) return notFound("Deployment not found or access denied")
      return ok(deployment)
    },
  }),
  defineTool({
    name: "get_build_logs",
    description: `Retrieve the end of a deployment's build log (the last ${DEFAULT_BUILD_LOG_LINES} lines by default), where a build failure is usually reported. When the log is longer, the first line of the result says which lines are shown and the offset to pass for the lines before them.`,
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Deployment ID" },
        lines: { type: "number", description: `Number of lines to return (default ${DEFAULT_BUILD_LOG_LINES}, max ${MAX_BUILD_LOG_LINES})` },
        offset: { type: "number", description: "Number of lines to skip from the end of the log, to read further back (default 0)" },
      },
      required: ["deployment_id"],
    },
    handler: async (args, userId) => {
      const deploymentId = arg(args, "deployment_id")
      if (!deploymentId) return err("deployment_id is required")
      const lines = argInt(args, "lines") ?? DEFAULT_BUILD_LOG_LINES
      if (!(lines >= 1)) return err("lines must be a positive integer")
      const offset = argInt(args, "offset") ?? 0
      if (!(offset >= 0)) return err("offset must be a non-negative integer")
      const logs = await getDeploymentLogTail(db, deploymentId, userId, { lines: Math.min(lines, MAX_BUILD_LOG_LINES), skip: offset })
      if (!logs) return notFound("Deployment not found or access denied")
      if (!logs.total) return ok({ message: "No build logs found (image-based deployments skip the build stage)" })
      if (!logs.items.length) return err(`offset ${offset} is past the start of the log, which has ${logs.total} lines`)
      return { content: [{ type: "text", text: buildLogText(logs.items, logs.total, offset) }] }
    },
  }),
  defineTool({
    name: "redeploy_deployment",
    description:
      "Deploy an already-built image again, without rebuilding (seconds instead of minutes). Creates a new deployment that uses the given deployment's image with the app's CURRENT settings, env vars and secrets. Two uses: (1) apply configuration changes — after set_env_var, delete_env_var, a secret change or a runtime-only update_app, pass the app's live deployment (get_app's liveDeployment); (2) roll back — pass an earlier deployment that was live (list_deployments). A rollback restores the earlier image only: the new deployment still uses the current settings, env vars and secrets, not the ones the earlier deployment had. Only works for deployments that have a built image and are live, stopped, failed or superseded.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "ID of the deployment whose image should be deployed again: the live one (get_app's liveDeployment) to apply configuration changes, an earlier live one to roll back" },
      },
      required: ["deployment_id"],
    },
    handler: async (args, userId) => {
      const deploymentId = arg(args, "deployment_id")
      if (!deploymentId) return err("deployment_id is required")
      const deployment = await redeployDeployment(db, deploymentId, userId)
      if (!deployment) return notFound("Deployment not found or access denied")
      return ok(deployment)
    },
  }),
  defineTool({
    name: "stop_app",
    description:
      "Take an app offline: its live deployment becomes 'stopped', its live URL is cleared and canette removes its running containers. Only the live deployment is stopped; if the latest deploy failed after creating its resources (e.g. crash-looping pods), those are removed too and the deployment stays 'failed'. A build or rollout that is still in progress doesn't go live afterwards: a build that finishes keeps its image and ends 'superseded', and a rollout is stopped. The app, its settings, env vars, secrets and volumes (including persistent data) are kept. To bring it back, call redeploy_deployment on the deployment that was live (returned here as stoppedDeployment, or from list_deployments), which reuses the built image without a rebuild.",
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
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      const live = await getLiveDeployment(db, appId)
      // false means the app is gone or not in one of the user's teams.
      if (!(await stopApp(db, appId, userId))) return notFound("App not found or access denied")
      return ok({
        stoppedDeployment: live?.id ?? null,
        note: live
          ? `The app is going offline. To bring it back, call redeploy_deployment with deployment_id ${live.id} (no rebuild needed).`
          : "The app had no live deployment. Anything a failed deploy left running is removed, and a build or rollout in progress won't go live.",
      })
    },
  }),
]

// Build log lines as plain text. When only part of the log is shown, a first
// line says which part and how to read further back.
function buildLogText(items: BuildLog[], total: number, offset: number): string {
  const text = items.map((l) => l.line).join("\n")
  if (items.length === total) return text
  const first = total - offset - items.length + 1
  const older = first > 1 ? ` For the ${first - 1} lines before these, call again with offset ${offset + items.length}.` : ""
  return `[Showing lines ${first}-${first + items.length - 1} of ${total}.${older}]\n${text}`
}
