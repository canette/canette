import { db } from "../../../db/db"
import { listProjects, createProject, getProjectByRef, updateProject } from "../../projects"
import { listApps } from "../../apps"
import { listTeams } from "../../teams"
import { arg } from "../args"
import { defineTool, err, notFound, ok, type ToolResult } from "../tool"

export const projectTools = [
  defineTool({
    name: "list_projects",
    description: "List all projects the authenticated user has access to.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, userId) => {
      const result = await listProjects(db, userId)
      return ok(result)
    },
  }),
  defineTool({
    name: "list_teams",
    description:
      "List the teams the authenticated user belongs to: ID, name, whether it is the user's personal team, and the user's role in it ('owner' or 'member'). Use a team ID as create_project's team_id. Unlike list_projects, this also finds teams that have no projects yet.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, userId) => {
      const teams = await listTeams(db, userId)
      return ok(
        teams.map((t) => ({
          id: t.id,
          name: t.name,
          isPersonal: Boolean(t.isPersonal), // SQLite (tests) returns 0/1
          role: t.ownerId === userId ? "owner" : "member",
        }))
      )
    },
  }),
  defineTool({
    name: "list_apps",
    description: "List all apps in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or slug" },
      },
      required: ["project_id"],
    },
    handler: async (args, userId) => {
      const projectId = arg(args, "project_id")
      if (!projectId) return err("project_id is required")
      const project = await getProjectByRef(db, projectId, userId)
      if (!project) return notFound("Project not found or access denied")
      const result = await listApps(db, project.id, userId)
      if (!result) return notFound("Project not found or access denied")
      return ok(result)
    },
  }),
  defineTool({
    name: "create_project",
    description: "Create a new project. Uses the user's personal team if team_id is not provided.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable project name" },
        slug: { type: "string", description: "URL-friendly identifier (lowercase alphanumeric and hyphens, max 50 chars)" },
        description: { type: "string", description: "Optional project description" },
        team_id: { type: "string", description: "Team ID from list_teams (optional — defaults to the user's personal team)" },
      },
      required: ["name", "slug"],
    },
    handler: async (args, userId) => {
      const name = arg(args, "name")
      const slug = arg(args, "slug")
      if (!name) return err("name is required")
      if (!slug) return err("slug is required")

      let teamId = arg(args, "team_id")
      if (!teamId) {
        const teams = await listTeams(db, userId)
        const personal = teams.find((t) => t.isPersonal)
        if (!personal) return notFound("No personal team found — provide a team_id explicitly")
        teamId = personal.id
      }

      const project = await createProject(db, userId, { teamId, name, slug, description: arg(args, "description") })
      return ok(project)
    },
  }),
  defineTool({
    name: "update_project",
    description:
      "Change a project's name or description. Only the fields you pass are changed. The slug can't be changed through MCP: it is part of every app's URL and of the project's Kubernetes resources.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID or slug" },
        name: { type: "string", description: "New human-readable project name" },
        description: { type: ["string", "null"], description: "New project description. Pass null or an empty string to remove it" },
      },
      required: ["project_id"],
    },
    handler: updateProjectTool,
  }),
]

// Name and description only: a slug change renames the project's namespace,
// which needs every app stopped first and is left to the UI.
async function updateProjectTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const projectId = arg(args, "project_id")
  if (!projectId) return err("project_id is required")
  if ("slug" in args) return err("The project slug can't be changed through MCP; change it in the project's settings in the canette UI")

  const patch: Parameters<typeof updateProject>[3] = {}
  if (args.name !== undefined) {
    if (typeof args.name !== "string") return err("name must be a string")
    patch.name = args.name
  }
  // null (or an empty string) removes the description; absent leaves it alone.
  if (args.description !== undefined) {
    if (args.description !== null && typeof args.description !== "string") return err("description must be a string or null")
    patch.description = args.description
  }
  if (!Object.keys(patch).length) return err("Pass name or description to change")

  const project = await getProjectByRef(db, projectId, userId)
  if (!project) return notFound("Project not found or access denied")
  return ok(await updateProject(db, project.id, userId, patch))
}
