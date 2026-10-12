import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { db } from "../db/db"
import { ServiceError } from "./errors"
import { listProjects, createProject, getProjectByRef } from "./projects"
import { listApps, createApp, getAppById } from "./apps"
import { createDeployment, listDeployments, getDeploymentLogs, getDeploymentById } from "./deployments"
import { listTeams } from "./teams"
import { listHostnames } from "./hostnames"
import { listEnvVars, upsertEnvVar, deleteEnvVar, MAX_ENV_VALUE_BYTES } from "./env-vars"
import { listSecrets } from "./secrets"
import { getAppPodTarget } from "./app-logs"
import { fetchFromLogstreamer } from "./logstreamer"
import type { AppMetricsUsage, AppRuntimeLogs } from "@canette/types"

const DEFAULT_LOG_LINES = 100
const MAX_LOG_LINES = 1000

// Env vars are snapshotted when a deployment is triggered, so a change does
// nothing to the running app until the next one.
const ENV_CHANGE_NOTE = "Takes effect on the next deployment — call trigger_deployment to apply it."

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "list_projects",
    description: "List all projects the authenticated user has access to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_apps",
    description: "List all apps in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or slug" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "create_project",
    description: "Create a new project. Uses the user's personal team if team_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable project name" },
        slug: { type: "string", description: "URL-friendly identifier (lowercase alphanumeric and hyphens, max 50 chars)" },
        description: { type: "string", description: "Optional project description" },
        team_id: { type: "string", description: "Team ID (optional — defaults to the user's personal team)" },
      },
      required: ["name", "slug"],
    },
  },
  {
    name: "create_app",
    description: "Create a new app within a project and configure it to build from a Git repository.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID" },
        name: { type: "string", description: "Human-readable app name" },
        slug: { type: "string", description: "URL-friendly identifier (lowercase alphanumeric and hyphens, max 63 chars)" },
        git_url: { type: "string", description: "Git repository URL (HTTPS or SSH)" },
        git_branch: { type: "string", description: "Git branch to build from (default: main)" },
        port: { type: "number", description: "Port the app listens on (default: 3000)" },
      },
      required: ["project_id", "name", "slug", "git_url"],
    },
  },
  {
    name: "trigger_deployment",
    description: "Trigger a new deployment for an existing app.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
  },
  {
    name: "list_deployments",
    description: "List the 10 most recent deployments for an app. Use this to find a deployment_id when troubleshooting a failed deployment that was not triggered by this session.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
  },
  {
    name: "get_deployment",
    description: "Get deployment details including status and error information.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Deployment ID" },
      },
      required: ["deployment_id"],
    },
  },
  {
    name: "get_build_logs",
    description: "Retrieve build logs for a deployment. Useful for diagnosing build failures.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Deployment ID" },
      },
      required: ["deployment_id"],
    },
  },
  {
    name: "get_app",
    description:
      "Get an app's configuration and current state: live URL, custom hostnames, latest deployment (status and error), and runtime health. Start here when checking whether an app is up.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
  },
  {
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
  },
  {
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
  },
  {
    name: "list_env_vars",
    description:
      "List an app's environment variables (keys and values) and the names of its secrets. Secret values are never returned. Use this to check whether a variable the app needs is missing.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
  },
  {
    name: "set_env_var",
    description:
      "Create or update a plaintext environment variable on an app. Takes effect on the next deployment. Do NOT use this for secrets (passwords, tokens, API keys, connection strings with credentials): values are stored unencrypted and are readable by the whole team. Ask the user to add secrets under the app's Environment settings in the canette UI instead.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        key: { type: "string", description: "Variable name: uppercase letters, digits and underscores (e.g. LOG_LEVEL)" },
        value: { type: "string", description: "Variable value (max 10 KB)" },
      },
      required: ["app_id", "key", "value"],
    },
  },
  {
    name: "delete_env_var",
    description: "Delete an environment variable from an app. Takes effect on the next deployment. Cannot delete secrets.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        key: { type: "string", description: "Variable name" },
      },
      required: ["app_id", "key"],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

function arg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === "string" ? v : undefined
}

function argBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return undefined
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    return isNaN(n) ? undefined : n
  }
  return undefined
}

export async function handleTool(name: string, args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_projects": {
        const result = await listProjects(db, userId)
        return ok(result)
      }

      case "list_apps": {
        const projectId = arg(args, "project_id")
        if (!projectId) return err("project_id is required")
        const project = await getProjectByRef(db, projectId, userId)
        if (!project) return err("Project not found or access denied")
        const result = await listApps(db, project.id, userId)
        if (!result) return err("Project not found or access denied")
        return ok(result)
      }

      case "create_project": {
        const name = arg(args, "name")
        const slug = arg(args, "slug")
        if (!name) return err("name is required")
        if (!slug) return err("slug is required")

        let teamId = arg(args, "team_id")
        if (!teamId) {
          const teams = await listTeams(db, userId)
          const personal = teams.find((t) => t.isPersonal)
          if (!personal) return err("No personal team found — provide a team_id explicitly")
          teamId = personal.id
        }

        const project = await createProject(db, userId, { teamId, name, slug, description: arg(args, "description") })
        return ok(project)
      }

      case "create_app": {
        const projectId = arg(args, "project_id")
        const name = arg(args, "name")
        const slug = arg(args, "slug")
        const gitUrl = arg(args, "git_url")
        if (!projectId) return err("project_id is required")
        if (!name) return err("name is required")
        if (!slug) return err("slug is required")
        if (!gitUrl) return err("git_url is required")

        const app = await createApp(db, projectId, userId, {
          name,
          slug,
          sourceType: "git",
          gitUrl,
          gitBranch: arg(args, "git_branch") ?? "main",
          port: argNum(args, "port") ?? 3000,
        })
        return ok(app)
      }

      case "list_deployments": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return err("App not found or access denied")
        const { items } = await listDeployments(db, appId, 10)
        return ok(items)
      }

      case "trigger_deployment": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return err("App not found or access denied")
        const deployment = await createDeployment(db, appId, userId)
        return ok(deployment)
      }

      case "get_deployment": {
        const deploymentId = arg(args, "deployment_id")
        if (!deploymentId) return err("deployment_id is required")
        const deployment = await getDeploymentById(db, deploymentId, userId)
        if (!deployment) return err("Deployment not found or access denied")
        return ok(deployment)
      }

      case "get_build_logs": {
        const deploymentId = arg(args, "deployment_id")
        if (!deploymentId) return err("deployment_id is required")
        const logs = await getDeploymentLogs(db, deploymentId, userId)
        if (!logs) return err("Deployment not found or access denied")
        if (!logs.length) return ok({ message: "No build logs found (image-based deployments skip the build stage)" })
        const text = logs.map((l) => l.line).join("\n")
        return { content: [{ type: "text", text }] }
      }

      case "get_app": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return err("App not found or access denied")
        const [hostnames, { items }] = await Promise.all([
          listHostnames(db, appId),
          listDeployments(db, appId, 1),
        ])
        return ok({ ...app, hostnames: hostnames.map((h) => h.hostname), latestDeployment: items[0] ?? null })
      }

      case "get_runtime_logs": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const podTarget = await getAppPodTarget(db, appId, userId)
        if (!podTarget) return err("App not found or access denied")

        const lines = argNum(args, "lines") ?? DEFAULT_LOG_LINES
        if (!Number.isInteger(lines) || lines < 1) return err("lines must be a positive integer")
        const params: Record<string, string> = { lines: String(Math.min(lines, MAX_LOG_LINES)) }
        if (argBool(args, "previous")) params.previous = "true"

        const deploymentId = arg(args, "deployment_id")
        if (deploymentId) {
          const deployment = await getDeploymentById(db, deploymentId, userId)
          if (!deployment || deployment.appId !== appId) return err("Deployment not found for this app")
          params.deployment_id = deploymentId
        }

        // Not scoped to the live deployment: a rollout that crash-loops never
        // becomes live, and its pod is exactly the one worth looking at.
        const result = await fetchFromLogstreamer<AppRuntimeLogs>("/logs/tail", podTarget, params, {
          scopeToLiveDeployment: false,
        })
        if (!result) return err("Could not reach the log service — try again shortly")
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
      }

      case "get_app_metrics": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const podTarget = await getAppPodTarget(db, appId, userId)
        if (!podTarget) return err("App not found or access denied")
        const usage = await fetchFromLogstreamer<AppMetricsUsage>("/metrics/usage", podTarget)
        if (!usage) return err("Could not reach the metrics service — try again shortly")
        return ok(usage)
      }

      case "list_env_vars": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return err("App not found or access denied")
        const [envVars, secrets] = await Promise.all([listEnvVars(db, appId), listSecrets(db, appId)])
        return ok({
          envVars: envVars.map((v) => ({ key: v.key, value: v.value })),
          secretKeys: secrets.map((s) => s.key),
        })
      }

      case "set_env_var": {
        const appId = arg(args, "app_id")
        const key = arg(args, "key")
        const value = arg(args, "value")
        if (!appId) return err("app_id is required")
        if (!key) return err("key is required")
        if (value === undefined) return err("value is required")
        if (Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES) return err("Value exceeds 10 KB limit")
        const app = await getAppById(db, appId, userId)
        if (!app) return err("App not found or access denied")
        const envVar = await upsertEnvVar(db, appId, key, value)
        return ok({ key: envVar.key, value: envVar.value, note: ENV_CHANGE_NOTE })
      }

      case "delete_env_var": {
        const appId = arg(args, "app_id")
        const key = arg(args, "key")
        if (!appId) return err("app_id is required")
        if (!key) return err("key is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return err("App not found or access denied")
        const deleted = await deleteEnvVar(db, appId, key)
        if (!deleted) return err(`No environment variable named ${key} on this app`)
        return ok({ deleted: key, note: ENV_CHANGE_NOTE })
      }

      default:
        return err(`Unknown tool: ${name}`)
    }
  } catch (e) {
    if (e instanceof ServiceError) return err(e.message)
    throw e
  }
}

export function buildMcpServer(userId: string): Server {
  const server = new Server(
    { name: "canette", version: process.env.APP_VERSION ?? "development" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    return handleTool(name, (rawArgs ?? {}) as Record<string, unknown>, userId)
  })

  return server
}
