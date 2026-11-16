import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { db } from "../db/db"
import { docs as defaultDocs, renderDocsPage, DOCS_VERSION, type DocsIndex } from "../docs"
import { getSchema, schemaFileFor, SCHEMA_TARGETS, type SchemaFile } from "../docs/schemas"
import { ServiceError } from "./errors"
import { listProjects, createProject, getProjectByRef } from "./projects"
import { listApps, createApp, updateApp, getAppById } from "./apps"
import {
  createDeployment,
  listDeployments,
  getDeploymentLogTail,
  getDeploymentById,
  getLiveDeployment,
  redeployDeployment,
} from "./deployments"
import { listTeams } from "./teams"
import { listHostnames } from "./hostnames"
import { listEnvVars, upsertEnvVar, deleteEnvVar, MAX_ENV_VALUE_BYTES } from "./env-vars"
import { listSecrets, validateSecretKey } from "./secrets"
import { listTeamCredentials } from "./git-credentials"
import { listVolumes, createVolume, updateVolume, deleteVolume } from "./volumes"
import { getPasswordGateStatus } from "./password-gate"
import { getAppPodTarget } from "./app-logs"
import { fetchFromLogstreamer } from "./logstreamer"
import type { AppDeploymentType, AppMetricsUsage, BuildLog, AppRuntimeLogs, AppSourceType, VolumeConfig, VolumeType } from "@canette/types"

const DEFAULT_LOG_LINES = 100
const MAX_LOG_LINES = 1000
const DEFAULT_BUILD_LOG_LINES = 200
const MAX_BUILD_LOG_LINES = 2000
const DEFAULT_DEPLOYMENTS = 10
const MAX_DEPLOYMENTS = 100

// request_secret limits (the reason limit also applies to
// request_password_protection). The UI pages apply the same ones, since the
// link's query string can be edited by hand.
const MAX_SECRET_REQUEST_KEYS = 10
const MAX_SECRET_REQUEST_REASON = 300

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

// App settings and env vars are snapshotted when a deployment is triggered,
// so a change does nothing to the running app until the next one. Which tool
// applies it matters: env vars and runtime settings are not build inputs, so
// redeploying the existing image is enough, while trigger_deployment runs a
// full build for a Git app. Agents default to the latter unless told otherwise.
const REDEPLOY_NOTE =
  "Takes effect on the next deployment. This change does not need a new build: apply it with redeploy_deployment on the app's live deployment (get_app's liveDeployment.id), which reuses the built image. If liveDeployment is null, redeploy the latest deployment that has a built image. Only use trigger_deployment if the app has no deployment with a built image yet."
const REBUILD_NOTE =
  "Takes effect on the next deployment. This changes what the app is built or run from, so call trigger_deployment to apply it."

// update_app arguments that change the source an image comes from. Anything
// else (name, port, schedule, deployment type) is applied at deploy time only.
const SOURCE_ARGS = ["source_type", "git_url", "git_branch", "app_path", "image_url", "image_tag", "git_credential_id"]

// Which volume type to pick is the part an agent can't infer from the schema.
const VOLUME_TYPES_NOTE =
  "Types: 'pvc' is a persistent disk that survives restarts and redeploys (databases, SQLite files, uploads); it requires size, locks the app to 1 replica, makes every deploy stop the old pod before starting the new one (brief downtime), and cannot be resized or changed later. 'emptyDir' is scratch space that is wiped whenever the pod restarts; size is an optional limit. 'configmap' mounts a single file with the given content at exactly mount_path (e.g. /etc/nginx/nginx.conf); the content is stored in plaintext and readable by the whole team, so never put secrets in it (use request_secret). Directory mounts over system paths (/etc, /usr, /var, ...) are rejected: use a path like /data."

// Sent to the client at initialize, alongside the per-tool descriptions.
const SERVER_INSTRUCTIONS = [
  "canette builds apps from Git into an image and deploys that image. There are two ways to start a deployment, and picking the right one matters:",
  "- trigger_deployment fetches the latest commit and runs a full build (minutes) before deploying. Use it when the source changed: new commits, or a different repository, branch, app path, credential or image tag. Also use it for an app's first deployment.",
  "- redeploy_deployment deploys an already-built image again (seconds) with the app's current settings, env vars and secrets. Use it when only configuration changed: env vars, secrets, port, schedule, deployment type, canette.yaml config, volumes, hostnames or password protection. Env vars are injected at runtime, not at build time, so a rebuild is never needed for them.",
  "Do not rebuild just to apply a configuration change. To redeploy, pass the ID of the app's live deployment: get_app's liveDeployment, not latestDeployment, which may be a failed or unfinished rollout.",
  "Runtime config such as resources, replicas, healthcheck, ingress and security lives in the app's canette.yaml. Change it with update_app's canette_config, then redeploy_deployment.",
  "Mounted volumes (persistent disks, scratch space, single config files) are managed with list_volumes, create_volume, update_volume and delete_volume, and applied with redeploy_deployment. Add a volume an app needs before its first deployment. Persistent volumes (pvc) cannot be deleted through these tools, because that destroys their data: delete_volume returns a link for the user to delete it themselves.",
  "To harden an app (non-root user, read-only root filesystem, no capabilities), set security.hardened: true in its canette.yaml after reading security/hardened-mode with get_docs_page: check that the image doesn't need root at startup and listens on a port of 1024 or higher (lower ports only work on some clusters), and list the directories it writes to in security.writable_paths. If you also change the Dockerfile, use trigger_deployment instead of redeploy_deployment.",
  "Never ask the user to paste a password, token, API key or connection string into the conversation, and never store one with set_env_var. Call request_secret instead: it returns a canette link where the user enters the value themselves, so it never reaches you.",
  "To put a web app behind a password, call request_password_protection: it returns a canette link where the user sets the password themselves. Never ask for that password either. Removing password protection makes the app public, so disable_password_protection only returns a link for the user to do it. Apply either change with redeploy_deployment.",
  "Before writing a canette.yaml or canette-template.yaml, or setting canette_config, read configuration/canette-yaml (and configuration/templates for templates) with get_docs_page, and check field names and values against get_canette_yaml_schema. Use search_docs for anything else about canette. These docs match the version of this canette instance, so prefer them over other sources.",
].join("\n")

const DOCS_NOT_BUNDLED = "Docs are not bundled in this build of the canette API."
const DOCS_URI_PREFIX = "canette-docs://"
const SCHEMA_URI_PREFIX = "canette-schema://"
const MAX_DOCS_RESULTS = 20

// ── Tool definitions ──────────────────────────────────────────────────────────

// When a tool here grants a new kind of access, update the permission list on
// the OAuth consent screen (apps/ui/src/app/oauth/authorize/consent-screen.tsx).
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    name: "redeploy_deployment",
    description:
      "Deploy an already-built image again, without rebuilding (seconds instead of minutes). Creates a new deployment that uses the given deployment's image with the app's CURRENT settings, env vars and secrets. Two uses: (1) apply configuration changes — after set_env_var, delete_env_var, a secret change or a runtime-only update_app, pass the app's live deployment (get_app's liveDeployment); (2) roll back — pass an earlier deployment that was live (list_deployments). A rollback restores the earlier image only: the new deployment still uses the current settings, env vars and secrets, not the ones the earlier deployment had. Only works for deployments that have a built image and are live, stopped or failed.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "ID of the deployment whose image should be deployed again: the live one (get_app's liveDeployment) to apply configuration changes, an earlier live one to roll back" },
      },
      required: ["deployment_id"],
    },
  },
  {
    name: "get_app",
    description:
      "Get an app's configuration and current state: live URL, custom hostnames, mounted volumes, whether password protection is on, the live deployment (the one serving traffic, null when the app is stopped or has never gone live) and the latest deployment (status and error; it may be a newer rollout that is still in progress or failed). Start here when checking whether an app is up.",
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
      "Create or update a plaintext environment variable on an app. Takes effect on the next deployment; env vars are injected at runtime, so apply the change with redeploy_deployment on the live deployment (get_app's liveDeployment), not trigger_deployment (no rebuild needed). Do NOT use this for secrets (passwords, tokens, API keys, connection strings with credentials): values are stored unencrypted and are readable by the whole team. Use request_secret for those instead.",
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
    name: "request_secret",
    description:
      "Ask the user to set one or more secrets (passwords, tokens, API keys, connection strings with credentials) on an app, without the value passing through you. Returns a link to a canette page where the logged-in user types the values; the link itself grants no access. Give the link to the user and wait until they say they are done — never ask for the value in the conversation. Then check secretKeys with list_env_vars and apply with redeploy_deployment. If a key already exists as a plain env var, the page offers to convert it.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_SECRET_REQUEST_KEYS,
          description: `Secret names: uppercase letters, digits and underscores (e.g. DATABASE_URL), at most ${MAX_SECRET_REQUEST_KEYS}`,
        },
        reason: {
          type: "string",
          description: `Short plain-text explanation shown to the user on the page, e.g. what the app needs the secret for (max ${MAX_SECRET_REQUEST_REASON} characters)`,
        },
      },
      required: ["app_id", "keys"],
    },
  },
  {
    name: "delete_env_var",
    description:
      "Delete an environment variable from an app. Takes effect on the next deployment; apply it with redeploy_deployment on the live deployment (get_app's liveDeployment), not trigger_deployment (no rebuild needed). Cannot delete secrets.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        key: { type: "string", description: "Variable name" },
      },
      required: ["app_id", "key"],
    },
  },
  {
    name: "list_volumes",
    description:
      "List an app's mounted volumes: ID, name, type (pvc, emptyDir or configmap), mount path and config (size, or the file content for a configmap).",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
  },
  {
    name: "create_volume",
    description: `Mount a volume into an app's container. ${VOLUME_TYPES_NOTE} ${REDEPLOY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        type: { type: "string", enum: ["pvc", "emptyDir", "configmap"], description: "Volume type" },
        mount_path: { type: "string", description: "Absolute path in the container: a directory for pvc and emptyDir, the file itself for configmap" },
        size: { type: "string", description: "Kubernetes quantity, e.g. '5Gi' or '500Mi': required for pvc, an optional limit for emptyDir" },
        content: { type: "string", description: "File content (max 1 MiB) — required for configmap" },
      },
      required: ["app_id", "type", "mount_path"],
    },
  },
  {
    name: "update_volume",
    description: `Change a volume's config: the file content of a configmap, or the size limit of an emptyDir. A pvc cannot be changed after creation. The type and mount path can't be changed: delete the volume and create a new one instead. ${REDEPLOY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        volume_id: { type: "string", description: "Volume ID (from list_volumes)" },
        size: { type: ["string", "null"], description: "emptyDir only: new size limit, e.g. '1Gi'. Pass null or an empty string to remove the limit" },
        content: { type: "string", description: "configmap only: the new file content, replacing the old one (max 1 MiB)" },
      },
      required: ["app_id", "volume_id"],
    },
  },
  {
    name: "delete_volume",
    description: `Remove an emptyDir or configmap volume from an app. Persistent volumes (pvc) cannot be deleted with this tool, because that permanently deletes their data: for a pvc it returns a link to the app's settings, where the user can delete it themselves. Give the user that link and don't look for another way to delete it. ${REDEPLOY_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
        volume_id: { type: "string", description: "Volume ID (from list_volumes)" },
      },
      required: ["app_id", "volume_id"],
    },
  },
  {
    name: "request_password_protection",
    description:
      "Ask the user to put a web app behind a password, without the password passing through you. Returns a link to a canette page where the logged-in user sets (or, if protection is already on, changes) one shared password; visitors then get a login form, and scripts can use HTTP Basic auth with any username. The link itself grants no access and changes nothing. Give the link to the user and wait until they say they are done — never ask for the password in the conversation. Then check passwordProtection with get_app and apply with redeploy_deployment.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID of a 'web' app" },
        reason: {
          type: "string",
          description: `Short plain-text explanation shown to the user on the page, e.g. why the app should be protected (max ${MAX_SECRET_REQUEST_REASON} characters)`,
        },
      },
      required: ["app_id"],
    },
  },
  {
    name: "disable_password_protection",
    description:
      "Remove password protection from an app. This makes its public URL reachable by anyone, so it is not done through MCP: the tool changes nothing and returns a link to the app's settings where the user can turn protection off themselves. Afterwards, apply the change with redeploy_deployment.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
  },
  {
    name: "search_docs",
    description:
      "Search the canette documentation (bundled with this instance, so it matches its version). Returns the best-matching sections with their page path; read a full page with get_docs_page.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. \"healthcheck\" or \"persistent volume\"" },
        limit: { type: "number", description: `Max results (default 5, max ${MAX_DOCS_RESULTS})` },
      },
      required: ["query"],
    },
  },
  {
    name: "get_docs_page",
    description:
      "Get one page of the canette documentation as markdown (bundled with this instance, so it matches its version). Key pages: configuration/canette-yaml (canette.yaml / canette_config reference), configuration/templates (canette-template.yaml), configuration/volumes, configuration/secrets, ai-agents/mcp. Use search_docs to find others.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Page path, e.g. \"configuration/canette-yaml\"" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_canette_yaml_schema",
    description:
      "Get the JSON Schema for canette.yaml (also the format of canette_config) or canette-template.yaml, bundled with this instance so it matches its version. Lists every field with its type, allowed values, defaults and a description. Unknown fields are allowed by canette but ignored.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: ["canette.yaml", "canette-template.yaml"],
          description: "Which file format to describe (default canette.yaml)",
        },
      },
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

// Tool errors use the REST error shape, so a client can branch on the code
// instead of parsing the message. Codes are a ServiceError's own, or:
// VALIDATION_ERROR (bad arguments), NOT_FOUND (also when access is denied, so
// other teams' resources stay invisible), UNAVAILABLE (a backing service is
// down or not configured), USER_ACTION_REQUIRED (refused over MCP; the message
// has a link for the user) and UNKNOWN_TOOL.
function err(message: string, code = "VALIDATION_ERROR"): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message, code }) }], isError: true }
}

function notFound(message: string): ToolResult {
  return err(message, "NOT_FOUND")
}

function arg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === "string" ? v : undefined
}

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

// An optional whole-number argument: undefined when absent, NaN when it was
// passed but is not a number, so the caller's range check rejects it.
function argInt(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined
  return Math.trunc(argNum(args, key) ?? NaN)
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
        if (!project) return notFound("Project not found or access denied")
        const result = await listApps(db, project.id, userId)
        if (!result) return notFound("Project not found or access denied")
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
          if (!personal) return notFound("No personal team found — provide a team_id explicitly")
          teamId = personal.id
        }

        const project = await createProject(db, userId, { teamId, name, slug, description: arg(args, "description") })
        return ok(project)
      }

      case "create_app": {
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
      }

      case "update_app": {
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
      }

      case "list_git_credentials": {
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
      }

      case "redeploy_deployment": {
        const deploymentId = arg(args, "deployment_id")
        if (!deploymentId) return err("deployment_id is required")
        const deployment = await redeployDeployment(db, deploymentId, userId)
        if (!deployment) return notFound("Deployment not found or access denied")
        return ok(deployment)
      }

      case "list_deployments": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
        const limit = argInt(args, "limit") ?? DEFAULT_DEPLOYMENTS
        if (!(limit >= 1)) return err("limit must be a positive integer")
        const { items } = await listDeployments(db, appId, Math.min(limit, MAX_DEPLOYMENTS))
        return ok(items)
      }

      case "trigger_deployment": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
        const deployment = await createDeployment(db, appId, userId)
        return ok(deployment)
      }

      case "get_deployment": {
        const deploymentId = arg(args, "deployment_id")
        if (!deploymentId) return err("deployment_id is required")
        const deployment = await getDeploymentById(db, deploymentId, userId)
        if (!deployment) return notFound("Deployment not found or access denied")
        return ok(deployment)
      }

      case "get_build_logs": {
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
      }

      case "get_app": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
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
      }

      case "get_runtime_logs": {
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
      }

      case "get_app_metrics": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const podTarget = await getAppPodTarget(db, appId, userId)
        if (!podTarget) return notFound("App not found or access denied")
        const usage = await fetchFromLogstreamer<AppMetricsUsage>("/metrics/usage", podTarget)
        if (!usage) return err("Could not reach the metrics service — try again shortly", "UNAVAILABLE")
        return ok(usage)
      }

      case "list_env_vars": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
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
        if (!app) return notFound("App not found or access denied")
        const envVar = await upsertEnvVar(db, appId, key, value)
        return ok({ key: envVar.key, value: envVar.value, note: REDEPLOY_NOTE })
      }

      case "request_secret":
        return await requestSecretTool(args, userId)

      case "request_password_protection":
        return await requestPasswordProtectionTool(args, userId)

      case "disable_password_protection":
        return await disablePasswordProtectionTool(args, userId)

      case "delete_env_var": {
        const appId = arg(args, "app_id")
        const key = arg(args, "key")
        if (!appId) return err("app_id is required")
        if (!key) return err("key is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
        const deleted = await deleteEnvVar(db, appId, key)
        if (!deleted) return notFound(`No environment variable named ${key} on this app`)
        return ok({ deleted: key, note: REDEPLOY_NOTE })
      }

      case "list_volumes": {
        const appId = arg(args, "app_id")
        if (!appId) return err("app_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
        return ok(await listVolumes(db, appId))
      }

      case "create_volume": {
        const appId = arg(args, "app_id")
        const type = arg(args, "type")
        const mountPath = arg(args, "mount_path")
        if (!appId) return err("app_id is required")
        if (!type) return err("type is required")
        if (!mountPath) return err("mount_path is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
        const volume = await createVolume(db, appId, userId, {
          type: type as VolumeType,
          mountPath,
          config: { size: arg(args, "size"), content: arg(args, "content") },
        })
        return ok({ ...volume, note: REDEPLOY_NOTE })
      }

      case "update_volume": {
        const appId = arg(args, "app_id")
        const volumeId = arg(args, "volume_id")
        if (!appId) return err("app_id is required")
        if (!volumeId) return err("volume_id is required")
        const app = await getAppById(db, appId, userId)
        if (!app) return notFound("App not found or access denied")
        if (!(await listVolumes(db, appId)).some((v) => v.id === volumeId)) return notFound("Volume not found on this app")
        // The service only touches size when the key is present; null clears it.
        const config: VolumeConfig = {}
        if ("size" in args) config.size = arg(args, "size") ?? ""
        if ("content" in args) config.content = arg(args, "content")
        const volume = await updateVolume(db, appId, volumeId, userId, { config })
        return ok({ ...volume, note: REDEPLOY_NOTE })
      }

      case "delete_volume":
        return await deleteVolumeTool(args, userId)

      case "search_docs":
        return searchDocsTool(args)

      case "get_docs_page":
        return getDocsPageTool(args)

      case "get_canette_yaml_schema":
        return getSchemaTool(args)

      default:
        return err(`Unknown tool: ${name}`, "UNKNOWN_TOOL")
    }
  } catch (e) {
    if (e instanceof ServiceError) return err(e.message, e.code)
    throw e
  }
}

// Build log lines as plain text. When only part of the log is shown, a first
// line says which part and how to read further back.
function buildLogText(items: BuildLog[], total: number, offset: number): string {
  const text = items.map((l) => l.line).join("\n")
  if (items.length === total) return text
  const first = total - offset - items.length + 1
  const older = first > 1 ? ` For the ${first - 1} lines before these, call again with offset ${offset + items.length}.` : ""
  return `[Showing lines ${first}-${first + items.length - 1} of ${total}.${older}]\n${text}`
}

// A link to one of the app's pages in the UI, e.g. "settings#volumes".
function appUiUrl(projectSlug: string, appSlug: string, path: string): string {
  const uiUrl = (process.env.UI_URL ?? "http://localhost:3000").replace(/\/$/, "")
  return `${uiUrl}/dashboard/projects/${encodeURIComponent(projectSlug)}/apps/${encodeURIComponent(appSlug)}/${path}`
}

// ── Volumes ───────────────────────────────────────────────────────────────────

// Deleting a PVC deletes its data for good, so that is left to the user in the
// UI. emptyDir and configmap volumes hold nothing that isn't recreated.
async function deleteVolumeTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  const volumeId = arg(args, "volume_id")
  if (!appId) return err("app_id is required")
  if (!volumeId) return err("volume_id is required")
  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")
  const volume = (await listVolumes(db, appId)).find((v) => v.id === volumeId)
  if (!volume) return notFound("Volume not found on this app")

  if (volume.type === "pvc") {
    const project = await getProjectByRef(db, app.projectId, userId)
    if (!project) return notFound("App not found or access denied")
    const url = appUiUrl(project.slug, app.slug, "settings#volumes")
    return err(
      `'${volume.name}' (${volume.mountPath}) is a persistent volume, and deleting it permanently deletes its data. Persistent volumes can't be deleted through MCP. Give the user this link to delete it themselves in the app's settings: ${url}`,
      "USER_ACTION_REQUIRED"
    )
  }

  await deleteVolume(db, appId, volumeId, userId)
  return ok({ deleted: volume.name, note: REDEPLOY_NOTE })
}

// ── Secret requests ───────────────────────────────────────────────────────────

type SecretRequestStatus = "new" | "replaces_secret" | "replaces_env_var"

// Returns a link for the user to set secrets in the UI. Writes nothing and
// never accepts a value: the page saves through the normal session-authed
// secrets endpoint, so the link is safe to show in the agent's context.
async function requestSecretTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  if (!appId) return err("app_id is required")

  const rawKeys = typeof args.keys === "string" ? [args.keys] : args.keys
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) return err("keys must be a non-empty list of secret names")
  if (!rawKeys.every((k): k is string => typeof k === "string")) return err("keys must be a list of strings")
  const keys = [...new Set(rawKeys.map((k) => k.trim()))]
  if (keys.length > MAX_SECRET_REQUEST_KEYS) return err(`Request at most ${MAX_SECRET_REQUEST_KEYS} secrets at a time`)
  for (const key of keys) {
    try {
      validateSecretKey(key)
    } catch (e) {
      if (e instanceof ServiceError) return err(`${key}: ${e.message}`, e.code)
      throw e
    }
  }

  const reason = parseReason(args)
  if (typeof reason !== "string") return reason

  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")
  const project = await getProjectByRef(db, app.projectId, userId)
  if (!project) return notFound("App not found or access denied")

  const [envVars, secrets] = await Promise.all([listEnvVars(db, appId), listSecrets(db, appId)])
  const envKeys = new Set(envVars.map((v) => v.key))
  const secretKeys = new Set(secrets.map((s) => s.key))
  const status = (key: string): SecretRequestStatus =>
    secretKeys.has(key) ? "replaces_secret" : envKeys.has(key) ? "replaces_env_var" : "new"

  const query = new URLSearchParams({ keys: keys.join(",") })
  if (reason) query.set("reason", reason)
  const url = appUiUrl(project.slug, app.slug, `request-secrets?${query}`)

  return ok({
    url,
    keys: keys.map((key) => ({ key, status: status(key) })),
    note:
      "Show this link to the user and ask them to open it while logged in to canette; it only works for members of the app's team. Do not ask for the values in the conversation. When the user says they are done, call list_env_vars and check that every key is in secretKeys. Secrets take effect on the next deployment: apply them with redeploy_deployment on the app's live deployment (get_app's liveDeployment, no rebuild needed), or trigger_deployment if the app has never been deployed.",
  })
}

// The agent-supplied reason shown on a request page: plain text, whitespace
// collapsed. Returns an error result when it is invalid.
function parseReason(args: Record<string, unknown>): string | ToolResult {
  const reasonArg = args.reason
  if (reasonArg !== undefined && reasonArg !== null && typeof reasonArg !== "string") return err("reason must be a string")
  const reason = (reasonArg ?? "").replace(/\s+/g, " ").trim()
  if (reason.length > MAX_SECRET_REQUEST_REASON) {
    return err(`reason must be at most ${MAX_SECRET_REQUEST_REASON} characters`)
  }
  return reason
}

// ── Password protection ───────────────────────────────────────────────────────

// Like request_secret: returns a link for the user to set the password in the
// UI, so it never passes through the agent. Writes nothing.
async function requestPasswordProtectionTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  if (!appId) return err("app_id is required")
  const reason = parseReason(args)
  if (typeof reason !== "string") return reason

  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")
  if (app.deploymentType !== "web") return err("Password protection is only supported for web apps")
  const project = await getProjectByRef(db, app.projectId, userId)
  if (!project) return notFound("App not found or access denied")

  const { enabled } = await getPasswordGateStatus(db, appId, userId)
  const query = reason ? `?${new URLSearchParams({ reason })}` : ""
  const url = appUiUrl(project.slug, app.slug, `request-password-protection${query}`)

  return ok({
    url,
    currentlyEnabled: enabled,
    note:
      `Show this link to the user and ask them to open it while logged in to canette; it only works for members of the app's team. ${enabled ? "Password protection is already on, so the page changes the password." : "The page turns password protection on."} Do not ask for the password in the conversation. When the user says they are done, call get_app and check passwordProtection.enabled. The change takes effect on the next deployment: apply it with redeploy_deployment on the app's live deployment (get_app's liveDeployment, no rebuild needed), or trigger_deployment if the app has never been deployed.`,
  })
}

// Removing protection makes the app's URL public, so, like deleting a
// persistent volume, it is left to the user in the UI.
async function disablePasswordProtectionTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  if (!appId) return err("app_id is required")
  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")

  const { enabled } = await getPasswordGateStatus(db, appId, userId)
  if (!enabled) return ok({ enabled: false, note: "Password protection is not on for this app; nothing to do." })

  const project = await getProjectByRef(db, app.projectId, userId)
  if (!project) return notFound("App not found or access denied")
  const url = appUiUrl(project.slug, app.slug, "settings#access")
  return err(
    `Removing password protection makes the app's public URL reachable by anyone, so it can't be done through MCP. Give the user this link to turn it off themselves in the app's settings: ${url}. Then apply the change with redeploy_deployment.`,
    "USER_ACTION_REQUIRED"
  )
}

// ── Docs (public, read-only — no DB or access checks) ─────────────────────────

export function searchDocsTool(args: Record<string, unknown>, index: DocsIndex = defaultDocs): ToolResult {
  if (index.isEmpty) return err(DOCS_NOT_BUNDLED, "UNAVAILABLE")
  const query = arg(args, "query")
  if (!query) return err("query is required")
  const limit = Math.min(Math.max(Math.trunc(argNum(args, "limit") ?? 5), 1), MAX_DOCS_RESULTS)
  const results = index.search(query, limit)
  return ok({ version: DOCS_VERSION, results })
}

export function getDocsPageTool(args: Record<string, unknown>, index: DocsIndex = defaultDocs): ToolResult {
  if (index.isEmpty) return err(DOCS_NOT_BUNDLED, "UNAVAILABLE")
  const path = arg(args, "path")
  if (!path) return err("path is required")
  const page = index.getPage(path)
  if (!page) {
    return err(`No docs page "${path}". Closest matches: ${index.suggest(path).join(", ")}. Use search_docs to find a page.`, "NOT_FOUND")
  }
  return { content: [{ type: "text", text: renderDocsPage(page) }] }
}

export function getSchemaTool(args: Record<string, unknown>): ToolResult {
  const target = arg(args, "file") ?? "canette.yaml"
  const file = schemaFileFor(target)
  if (!file) return err(`Unknown file "${target}". Use "canette.yaml" or "canette-template.yaml".`)
  return { content: [{ type: "text", text: getSchema(file) }] }
}

export function registerDocsResources(server: Server, index: DocsIndex = defaultDocs): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...(Object.entries(SCHEMA_TARGETS) as [SchemaFile, string][]).map(([file, yaml]) => ({
        uri: `${SCHEMA_URI_PREFIX}${file}`,
        name: file,
        title: `${yaml} JSON Schema`,
        description: `Every ${yaml} field with its type, allowed values and description`,
        mimeType: "application/schema+json",
      })),
      ...index.list().map((p) => ({
        uri: `${DOCS_URI_PREFIX}${p.path}`,
        name: p.path,
        title: p.title,
        description: p.description || undefined,
        mimeType: "text/markdown",
      })),
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    if (uri.startsWith(SCHEMA_URI_PREFIX)) {
      const file = schemaFileFor(uri.slice(SCHEMA_URI_PREFIX.length))
      if (!file) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
      return { contents: [{ uri, mimeType: "application/schema+json", text: getSchema(file) }] }
    }
    const page = uri.startsWith(DOCS_URI_PREFIX) ? index.getPage(uri) : undefined
    if (!page) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`)
    return { contents: [{ uri, mimeType: "text/markdown", text: renderDocsPage(page) }] }
  })
}

export function buildMcpServer(userId: string): Server {
  const server = new Server(
    { name: "canette", version: process.env.APP_VERSION ?? "development" },
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  registerDocsResources(server)

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    return handleTool(name, (rawArgs ?? {}) as Record<string, unknown>, userId)
  })

  return server
}
