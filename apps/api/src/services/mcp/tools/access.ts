import { db } from "../../../db/db"
import { ServiceError } from "../../errors"
import { getProjectByRef } from "../../projects"
import { getAppById } from "../../apps"
import { getPasswordGateStatus } from "../../password-gate"
import { checkWebhookSupport, createWebhook, deleteWebhook, getWebhook } from "../../webhooks"
import { arg, argBool } from "../args"
import { appUiUrl, defineTool, err, notFound, ok, type ToolResult } from "../tool"
import { MAX_SECRET_REQUEST_REASON, parseReason } from "./env"

export const accessTools = [
  defineTool({
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
    handler: requestPasswordProtectionTool,
  }),
  defineTool({
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
    handler: disablePasswordProtectionTool,
  }),
  defineTool({
    name: "get_webhook",
    description:
      "Check whether pushes to a Git app's branch deploy it automatically: whether a webhook is configured, for which provider, its watch path, whether canette registered it with the provider itself (autoRegistered) and when the provider first reached it (verifiedAt; unset means no push or ping has arrived yet). Also says whether enable_webhook can register a webhook without the user's help, and why not. Never returns the webhook secret, and changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
    handler: getWebhookTool,
  }),
  defineTool({
    name: "enable_webhook",
    description:
      "Turn on automatic deployments for a Git app: canette creates a webhook secret and registers a push webhook with GitHub, GitLab or Gitea using the app's Git credential (a personal access token or GitHub App, not an SSH key). Each push to the app's branch then triggers a build, unless the app is stopped or a deployment is already in progress. The secret is never returned. If canette can't register the webhook itself (no suitable credential, or the provider refuses the token), nothing is enabled and the tool returns a link where the user sets it up in the canette UI, which shows them the secret to add in the provider. An app has one webhook: if it already has one, the call fails unless replace is true, which creates a new secret and removes the old webhook, so call get_webhook first.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID of a Git app" },
        watch_path: {
          type: "string",
          description: "Only deploy when a push changes files under this directory, relative to the repository root (e.g. 'apps/web' in a monorepo). Omit to deploy on every push to the branch.",
        },
        replace: {
          type: "boolean",
          description: "Replace an existing webhook (new secret, old webhook removed). Only set this when the user asked to rotate the secret or change the watch path.",
        },
      },
      required: ["app_id"],
    },
    handler: enableWebhookTool,
  }),
  defineTool({
    name: "disable_webhook",
    description:
      "Turn off automatic deployments for an app by removing its webhook. Pushes no longer deploy; trigger_deployment still works. If canette registered the webhook with the provider, it is removed there as well; a webhook the user added by hand has to be deleted in the provider's repository settings.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string", description: "App ID" },
      },
      required: ["app_id"],
    },
    handler: disableWebhookTool,
  }),
]

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

// ── Webhooks ──────────────────────────────────────────────────────────────────

// The webhook secret is shown once, to whoever creates the webhook. Through
// MCP that would be the agent, so these tools never return it: a webhook the
// user has to add by hand is created in the UI instead.

async function getWebhookTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  if (!appId) return err("app_id is required")
  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")

  const webhook = await getWebhook(db, appId, userId)
  let support
  try {
    support = await checkWebhookSupport(db, appId, userId)
  } catch (e) {
    // An app that can't have a webhook (not Git, no or unsupported URL).
    if (e instanceof ServiceError && e.code !== "NOT_FOUND") {
      return ok({ enabled: Boolean(webhook), supported: false, reason: e.message, ...(webhook && { webhook }) })
    }
    throw e
  }
  return ok({
    enabled: Boolean(webhook),
    supported: true,
    webhook,
    autoRegistration: support.autoRegister,
  })
}

async function enableWebhookTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  if (!appId) return err("app_id is required")
  const watchPathArg = args.watch_path
  if (watchPathArg !== undefined && watchPathArg !== null && typeof watchPathArg !== "string") {
    return err("watch_path must be a string")
  }
  // Changed files are matched against paths relative to the repository root.
  const watchPath = (watchPathArg ?? "").trim().replace(/^(\.?\/)+/, "")
  const replace = argBool(args, "replace") === true

  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")
  // Throws for an app that can't have a webhook.
  const support = await checkWebhookSupport(db, appId, userId)

  const existing = await getWebhook(db, appId, userId)
  if (existing && !replace) {
    return err(
      `This app already has a webhook (watch path: ${existing.watchPath ? `'${existing.watchPath}'` : "none"}), so pushes already deploy it. Replacing it creates a new secret and removes the old webhook: only pass replace: true if the user asked for that.`,
      "CONFLICT"
    )
  }

  const project = await getProjectByRef(db, app.projectId, userId)
  if (!project) return notFound("App not found or access denied")
  const settingsUrl = appUiUrl(project.slug, app.slug, "settings#webhook")
  const manualSetup = (reason: string, changed: string) =>
    err(
      `${reason} ${changed} The webhook has to be added in ${support.provider} by hand, with a secret only the user should see. Give the user this link to enable it in the app's settings, which shows the URL and secret to add: ${settingsUrl}` +
        (existing ? " (disable the webhook there first, then enable it again)" : "") +
        ". Alternatively, connect a Git credential with permission to manage webhooks (update_app's git_credential_id) and call enable_webhook again.",
      "USER_ACTION_REQUIRED"
    )

  if (!support.autoRegister.possible) return manualSetup(support.autoRegister.reason, "Nothing was changed.")

  const result = await createWebhook(db, appId, userId, { watchPath })
  if (!result.autoRegistered) {
    // The new secret can't be shown to anyone through MCP, so don't keep a
    // webhook nobody can configure.
    await deleteWebhook(db, appId, userId)
    return manualSetup(
      result.autoRegisterFailureReason ?? `canette could not register the webhook with ${support.provider}.`,
      existing ? "The app's previous webhook was removed and no new one was enabled." : "Nothing was enabled."
    )
  }

  return ok({
    webhook: result.config,
    replaced: Boolean(existing),
    note: `canette registered the webhook with ${support.provider}. Every push to the '${app.gitBranch}' branch${watchPath ? ` that changes files under '${watchPath}'` : ""} now triggers a build and deployment, unless the app is stopped or a deployment is in progress. get_webhook's verifiedAt is set once the first push or ping arrives.`,
  })
}

async function disableWebhookTool(args: Record<string, unknown>, userId: string): Promise<ToolResult> {
  const appId = arg(args, "app_id")
  if (!appId) return err("app_id is required")
  const app = await getAppById(db, appId, userId)
  if (!app) return notFound("App not found or access denied")

  const existing = await getWebhook(db, appId, userId)
  if (!existing || !(await deleteWebhook(db, appId, userId))) {
    return ok({ enabled: false, note: "This app has no webhook; nothing to do." })
  }
  return ok({
    enabled: false,
    note: existing.autoRegistered
      ? `Pushes no longer deploy the app. canette also removed the webhook from ${existing.provider} if its Git credential still allows that; otherwise it stays in the repository's webhook settings, failing, until the user deletes it there.`
      : `Pushes no longer deploy the app. The webhook was added in ${existing.provider} by hand, so canette can't remove it there: ask the user to delete it in the repository's webhook settings (it points at ${existing.webhookUrl}).`,
  })
}
