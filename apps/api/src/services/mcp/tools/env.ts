import { db } from "../../../db/db"
import { ServiceError } from "../../errors"
import { getProjectByRef } from "../../projects"
import { getAppById } from "../../apps"
import { listEnvVars, upsertEnvVar, deleteEnvVar, MAX_ENV_VALUE_BYTES } from "../../env-vars"
import { listSecrets, validateSecretKey } from "../../secrets"
import { arg } from "../args"
import { REDEPLOY_NOTE } from "../notes"
import { appUiUrl, defineTool, err, notFound, ok, type ToolResult } from "../tool"

// request_secret limits (the reason limit also applies to
// request_password_protection). The UI pages apply the same ones, since the
// link's query string can be edited by hand.
const MAX_SECRET_REQUEST_KEYS = 10
export const MAX_SECRET_REQUEST_REASON = 300

export const envTools = [
  defineTool({
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
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      if (!appId) return err("app_id is required")
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      const [envVars, secrets] = await Promise.all([listEnvVars(db, appId), listSecrets(db, appId)])
      return ok({
        envVars: envVars.map((v) => ({ key: v.key, value: v.value })),
        secretKeys: secrets.map((s) => s.key),
      })
    },
  }),
  defineTool({
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
    handler: async (args, userId) => {
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
    },
  }),
  defineTool({
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
    handler: requestSecretTool,
  }),
  defineTool({
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
    handler: async (args, userId) => {
      const appId = arg(args, "app_id")
      const key = arg(args, "key")
      if (!appId) return err("app_id is required")
      if (!key) return err("key is required")
      const app = await getAppById(db, appId, userId)
      if (!app) return notFound("App not found or access denied")
      const deleted = await deleteEnvVar(db, appId, key)
      if (!deleted) return notFound(`No environment variable named ${key} on this app`)
      return ok({ deleted: key, note: REDEPLOY_NOTE })
    },
  }),
]

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
export function parseReason(args: Record<string, unknown>): string | ToolResult {
  const reasonArg = args.reason
  if (reasonArg !== undefined && reasonArg !== null && typeof reasonArg !== "string") return err("reason must be a string")
  const reason = (reasonArg ?? "").replace(/\s+/g, " ").trim()
  if (reason.length > MAX_SECRET_REQUEST_REASON) {
    return err(`reason must be at most ${MAX_SECRET_REQUEST_REASON} characters`)
  }
  return reason
}
