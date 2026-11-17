import { db } from "../../../db/db"
import { getProjectByRef } from "../../projects"
import { createApp, updateApp } from "../../apps"
import { listTeamCredentials } from "../../git-credentials"
import { arg, argNum } from "../args"
import { REBUILD_NOTE, REDEPLOY_NOTE } from "../notes"
import { defineTool, err, notFound, ok, type ToolResult } from "../tool"
import type { AppDeploymentType, AppSourceType } from "@canette/types"

// Shared by create_app and update_app. Values are validated by the apps service.
const APP_SOURCE_PROPERTIES = {
  source_type: { type: "string", enum: ["git", "image"], description: "Build from a Git repository ('git') or run a prebuilt Docker image ('image')" },
  git_url: { type: "string", description: "Git repository URL (HTTPS or SSH) — for source_type 'git'" },
  git_branch: { type: "string", description: "Git branch to build from" },
  app_path: { type: "string", description: "Subdirectory of the repository that contains the app, for monorepos (e.g. 'apps/web')" },
  image_url: { type: "string", description: "Docker image without tag (e.g. 'ghcr.io/org/app') — for source_type 'image'" },
  image_tag: { type: "string", description: "Docker image tag" },
  port: { type: "number", description: "Port the app listens on (not used for cronjob apps)" },
  schedule: { type: "string", description: "Cron expression (e.g. '0 2 * * *' or '@daily') — required for deployment_type 'cronjob'" },
  canette_config: {
    type: ["string", "null"],
    description:
      "The app's runtime config as a full canette.yaml document (resources, replicas, healthcheck, runtime, env, ingress, security). Replaces the stored document, it is not merged: read the current value from get_app's canetteConfig first and send the complete result. For a Git app, a canette.yaml committed in the repository wins field by field after the build, so check the repository first. build.* fields only apply to Git apps, at the next build. get_canette_yaml_schema lists every field. Pass null or an empty string to clear it.",
  },
} as const

// update_app arguments that change the source an image comes from. Anything
// else (name, port, schedule, deployment type) is applied at deploy time only.
const SOURCE_ARGS = ["source_type", "git_url", "git_branch", "app_path", "image_url", "image_tag", "git_credential_id"]

export const appTools = [
  defineTool({
    name: "create_app",
    description:
      "Create a new app within a project, built from a Git repository (default) or run from a prebuilt Docker image. For a private repository, pass a git_credential_id from list_git_credentials. Does not deploy — call trigger_deployment afterwards. If the app needs storage (e.g. a persistent disk for a database), add it with create_volume before the first trigger_deployment.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID" },
        name: { type: "string", description: "Human-readable app name" },
        slug: { type: "string", description: "URL-friendly identifier (lowercase alphanumeric and hyphens, max 63 chars)" },
        ...APP_SOURCE_PROPERTIES,
        deployment_type: {
          type: "string",
          enum: ["web", "private", "cronjob"],
          description:
            "'web' gets a public URL (default), 'private' is reachable only inside the cluster, 'cronjob' runs on a schedule. An app cannot be changed to or from 'cronjob' later.",
        },
        git_credential_id: { type: "string", description: "Git credential ID for a private repository (from list_git_credentials)" },
      },
      required: ["project_id", "name", "slug"],
    },
    handler: async (args, userId) => {
      const projectId = arg(args, "project_id")
      const name = arg(args, "name")
      const slug = arg(args, "slug")
      if (!projectId) return err("project_id is required")
      if (!name) return err("name is required")
      if (!slug) return err("slug is required")
      const configErr = checkCanetteConfigArg(args)
      if (configErr) return configErr

      const app = await createApp(db, projectId, userId, {
        name,
        slug,
        ...appPatch(args),
        gitCredentialId: arg(args, "git_credential_id"),
        canetteConfig: arg(args, "canette_config") || undefined,
      })
      return ok(app)
    },
  }),
  defineTool({
    name: "update_app",
    description:
      "Change an existing app's settings, such as its branch, port or image tag. Only the fields you pass are changed. Takes effect on the next deployment: after changing the source (repository, branch, app path, credential, image) call trigger_deployment; after changing only runtime settings (port, schedule, deployment type, name, canette_config) call redeploy_deployment on the live deployment (get_app's liveDeployment) instead, which skips the build.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        name: { type: "string", description: "Human-readable app name" },
        ...APP_SOURCE_PROPERTIES,
        deployment_type: {
          type: "string",
          enum: ["web", "private"],
          description: "Switch between 'web' (public URL) and 'private' (cluster-internal). Cannot change to or from 'cronjob'.",
        },
        git_credential_id: {
          type: ["string", "null"],
          description: "Git credential ID (from list_git_credentials). Pass null to remove the credential.",
        },
      },
      required: ["app_id"],
    },
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      if (!appId) return err("app_id is required")

      const patch: Parameters<typeof updateApp>[3] = { name: arg(args, "name"), ...appPatch(args) }
      // null (or an empty string) removes the credential; absent leaves it alone.
      if ("git_credential_id" in args) patch.gitCredentialId = arg(args, "git_credential_id") || null
      if ("canette_config" in args) {
        const configErr = checkCanetteConfigArg(args)
        if (configErr) return configErr
        patch.canetteConfig = arg(args, "canette_config") || null
      }
      if (Object.values(patch).every((v) => v === undefined)) return err("Pass at least one setting to change")

      const app = await updateApp(db, appId, userId, patch)
      if (!app) return notFound("App not found or access denied")
      const sourceChanged = SOURCE_ARGS.some((key) => key in args)
      return ok({ ...app, note: sourceChanged ? REBUILD_NOTE : REDEPLOY_NOTE })
    },
  }),
  defineTool({
    name: "list_git_credentials",
    description:
      "List the Git credentials available to a project (its team's credentials plus system-wide ones), for use as git_credential_id on a private repository. Returns names and types only — never tokens or keys. Credentials are created in the canette UI.",
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
      const credentials = await listTeamCredentials(db, project.teamId, userId)
      if (!credentials) return notFound("Project not found or access denied")
      return ok(
        credentials.map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          type: c.type,
          scope: c.teamId === null ? "system" : "team",
        }))
      )
    },
  }),
]

// appPatch reads the settings shared by create_app and update_app, leaving out
// anything the caller didn't pass so the service applies its own defaults.
function appPatch(args: Record<string, unknown>) {
  return {
    sourceType: arg(args, "source_type") as AppSourceType | undefined,
    deploymentType: arg(args, "deployment_type") as AppDeploymentType | undefined,
    gitUrl: arg(args, "git_url"),
    gitBranch: arg(args, "git_branch"),
    appPath: arg(args, "app_path"),
    imageUrl: arg(args, "image_url"),
    imageTag: arg(args, "image_tag"),
    port: argNum(args, "port"),
    schedule: arg(args, "schedule"),
  }
}

// Without this check a YAML object passed as canette_config would read as
// absent and, on update_app, clear the stored config.
function checkCanetteConfigArg(args: Record<string, unknown>): ToolResult | undefined {
  const v = args.canette_config
  if (v === undefined || v === null || typeof v === "string") return undefined
  return err("canette_config must be the canette.yaml document as a string (or null to clear it)")
}
