import { Hono } from "hono"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { db } from "../db/db"
import { requireBearer, type McpEnv } from "../middleware/require-bearer"
import { ServiceError } from "../services/errors"
import { listProjects, createProject, getProjectByRef } from "../services/projects"
import { listApps, createApp, getAppById } from "../services/apps"
import { createDeployment, listDeployments, getDeploymentLogs, getDeploymentById } from "../services/deployments"
import { listTeams } from "../services/teams"

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
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

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    return isNaN(n) ? undefined : n
  }
  return undefined
}

async function handleTool(name: string, args: Record<string, unknown>, userId: string): Promise<ToolResult> {
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

      default:
        return err(`Unknown tool: ${name}`)
    }
  } catch (e) {
    if (e instanceof ServiceError) return err(e.message)
    throw e
  }
}

// ── Server factory ────────────────────────────────────────────────────────────

function buildMcpServer(userId: string): Server {
  const server = new Server(
    { name: "canette", version: "1.0.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    return handleTool(name, (rawArgs ?? {}) as Record<string, unknown>, userId)
  })

  return server
}

// ── Hono router ───────────────────────────────────────────────────────────────

export const mcpRouter = new Hono<McpEnv>()

mcpRouter.use("*", requireBearer)

mcpRouter.all("/", async (c) => {
  const userId = c.get("mcpUserId")
  const server = buildMcpServer(userId)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})
